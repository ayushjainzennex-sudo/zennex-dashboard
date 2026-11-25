// Search ranking tracker: categories → subcategories (e.g. budgets) → search queries.
// Each check records where the category's channel ranks for every query and raises alerts when it slips.
import {db, tx, batch} from './db.js';
import {claim, release, heldByOthers, activeWorkers, isActive, currentMode, countWork} from './cluster.js';
import {searchVideos, parseAge} from './youtube.js';
import {evaluate, pendingSubs, hotSubs, watchdogData, queryTimeline, snooze, muteQuery, scoreSeries} from './watchdog.js';

const TOP = 2; // "top 2" target from the brief
const iso = (t = Date.now()) => new Date(t).toISOString();
// Queries may contain {year}; it is replaced with the current year at check time, so "best laptop {year}" never goes stale.
export const resolveQuery = q => q.replace(/\{year\}/gi, String(new Date().getFullYear()));

// ---------- grouping near-duplicate searches ----------
// "laptop under 30k", "best laptop under 30000" and "best 30000 laptop" return nearly the same results.
// In categories NOT marked important, one search per group stands in for the others for SHARE_WINDOW;
// the group member searched rotates naturally (whichever budget comes due first). Important categories
// and manual checks always search every wording.
const SHARE_WINDOW = 4 * 3600e3;
const FILLER = new Set(['best', 'top', 'the', 'a', 'an', 'in', 'for', 'of', 'to', 'and', 'with', 'buy', 'which', 'should', 'you', 'is', 'india', 'new', 'latest', 'under', 'below', 'within', 'budget']);
export function groupKey(text) {
  return String(text).toLowerCase().replace(/\{year\}|\b20\d\d\b/g, ' ').replace(/₹|rs\.?\s*/g, ' ').replace(/(\d),(?=\d)/g, '$1')
    .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, n) => String(Math.round(n * 1000)))
    .replace(/(\d+(?:\.\d+)?)\s*(?:lakhs?|lacs?|l)\b/g, (_, n) => String(Math.round(n * 100000)))
    .split(/[^a-z0-9]+/).filter(Boolean).map(w => w.length > 3 && w.endsWith('s') && !/\d/.test(w) ? w.slice(0, -1) : w)
    .filter(w => !FILLER.has(w)).sort().join(' ');
}
// For each non-important category: query id -> ids of the other queries in its group.
function groups() {
  const rows = db.prepare(`SELECT q.id, q.query, s.category FROM rank_queries q JOIN rank_subcategories s ON s.id=q.sub JOIN rank_categories c ON c.id=s.category WHERE q.muted=0 AND c.important=0`).all();
  const byKey = new Map();
  for (const q of rows) { const k = q.category + '|' + groupKey(q.query); (byKey.get(k) ?? byKey.set(k, []).get(k)).push(q.id); }
  const out = new Map();
  for (const ids of byKey.values()) if (ids.length > 1) for (const id of ids) out.set(id, ids.filter(x => x !== id));
  return out;
}
// Latest real (not shared) result of a group sibling within the window.
function sharedResult(siblings) {
  if (!siblings?.length) return null;
  return db.prepare(`SELECT * FROM rank_results WHERE query IN (${siblings.map(() => '?').join(',')}) AND error IS NULL AND shared_from IS NULL AND ts>=? ORDER BY ts DESC LIMIT 1`)
    .get(...siblings, iso(Date.now() - SHARE_WINDOW)) ?? null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

db.exec(`
  CREATE TABLE IF NOT EXISTS rank_categories (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL,
    channel INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rank_subcategories (
    id INTEGER PRIMARY KEY,
    category INTEGER NOT NULL REFERENCES rank_categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    status TEXT, checked_at TEXT                     -- strong | weak | missing
  );
  CREATE TABLE IF NOT EXISTS rank_queries (
    id INTEGER PRIMARY KEY,
    sub INTEGER NOT NULL REFERENCES rank_subcategories(id) ON DELETE CASCADE,
    query TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rank_results (
    query INTEGER NOT NULL REFERENCES rank_queries(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    rank INTEGER,                                    -- best position of the channel, NULL if not in results
    video TEXT, total INTEGER, top TEXT, error TEXT  -- top = JSON of the first 5 results
  );
  CREATE INDEX IF NOT EXISTS rank_results_by_time ON rank_results(query, ts);
`);

// Seed: Laptop budgets for Techum.
if (!db.prepare(`SELECT count(*) n FROM rank_categories`).get().n) {
  const techum = db.prepare(`SELECT id FROM channels WHERE path='@techum'`).get()?.id;
  if (techum) tx(() => {
    const cat = db.prepare(`INSERT INTO rank_categories (name, channel) VALUES ('Laptop', ?)`).run(techum).lastInsertRowid;
    [30, 40, 50, 60, 70, 80, 100].forEach((k, i) => {
      const n = k * 1000, lakh = k === 100;
      const label = lakh ? '1 lakh' : String(n), short = lakh ? '1 lakh' : k + 'k';
      const sub = db.prepare(`INSERT INTO rank_subcategories (category, name, position) VALUES (?,?,?)`).run(cat, lakh ? 'Under ₹1 lakh' : `Under ₹${k}K`, i).lastInsertRowid;
      [`laptop under ${label}`, `laptop under ${lakh ? '100000' : short}`, `best laptop under ${label}`, `best ${label} laptop`, `best laptop under ${short} {year}`, `laptop under ${label} for students`]
        .forEach((q, j) => db.prepare(`INSERT INTO rank_queries (sub, query, position) VALUES (?,?,?)`).run(sub, q, j));
    });
  });
}

// Earlier versions stored a literal year; switch those to the {year} placeholder.
db.prepare(`UPDATE rank_queries SET query = replace(query, ?, '{year}') WHERE query LIKE ?`).run(String(new Date().getFullYear()), '%' + new Date().getFullYear() + '%');

// ---------- checking ----------
// A background worker checks one budget at a time, all day, instead of firing every search in one burst.
// Pace = cycle ÷ searches due per cycle (floor MIN_GAP), with random jitter. Weak/missing budgets are due every cycle,
// strong ones every second cycle. Repeated failures (429s, consent pages, stripped results) pause checking with backoff.
const RANK_CYCLE = 24 * 3600e3; // window for the "checked in the last 24h" figure
const MIN_GAP = 20e3, MANUAL_GAP = [3e3, 6e3], PAUSES = [30, 60, 120, 240].map(m => m * 60e3), FAILS_TO_PAUSE = 3;
const state = globalThis.__ytRankings ??= {};
Object.assign(state, {timer: state.timer ?? null, job: state.job ?? null, manual: state.manual ?? null, stop: false,
  fails: state.fails ?? 0, pauseLevel: state.pauseLevel ?? 0, pausedUntil: state.pausedUntil ?? 0, nextAt: state.nextAt ?? null, current: state.current ?? null});
const jitter = ms => ms * (0.6 + Math.random() * 0.8);

try { db.exec(`ALTER TABLE rank_categories ADD COLUMN important INTEGER NOT NULL DEFAULT 0`); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS rank_lease (id INTEGER PRIMARY KEY CHECK (id=1), pid INTEGER, until TEXT)`);
// Nodes share the budgets: each budget is leased by one node while it is checked (see cluster.js).
const LEASE_MS = 45 * 60e3;

function statusOf(results) {
  const checked = results.filter(r => !r.error);
  if (!checked.length) return null;
  const top = checked.filter(r => r.rank != null && r.rank <= TOP).length;
  if (!checked.some(r => r.rank != null)) return 'missing';
  return top > checked.length / 2 ? 'strong' : 'weak';
}

const blocked = err => /\b429\b|not found on the page|incomplete results|consent|timed? ?out|fetch failed/i.test(err.message);
function failed(err, alert) {
  if (!blocked(err)) return false;
  if (++state.fails < FAILS_TO_PAUSE) return false;
  const ms = PAUSES[Math.min(state.pauseLevel, PAUSES.length - 1)];
  state.pausedUntil = Date.now() + ms; state.fails = 0;
  if (state.pauseLevel++ === 0) alert('ranking', null, null, 'Rank checks paused', `YouTube is limiting searches (${err.message}). Checking resumes automatically in ${ms / 60e3} minutes.`);
  console.warn(`[dashboard] rank checks paused ${ms / 60e3} min: ${err.message}`);
  return true;
}
const succeeded = () => { state.fails = 0; state.pauseLevel = 0; };

// Returns false when interrupted (pause, shutdown or a manual check); nothing is saved then, so the budget stays due.
async function checkSub(sub, alert, gap, isCancelled, manual = false) {
  const cat = db.prepare(`SELECT c.*, ch.channel_id, ch.name channel_name FROM rank_categories c JOIN channels ch ON ch.id=c.channel WHERE c.id=?`).get(sub.category);
  if (!cat?.channel_id) return true;
  const queries = db.prepare(`SELECT * FROM rank_queries WHERE sub=? AND muted=0 ORDER BY position, id`).all(sub.id);
  const ts = iso(), results = [];
  const sibs = cat.important || manual ? new Map() : groups();
  state.current = {sub: sub.id, name: `${cat.name} · ${sub.name}`, done: 0, total: queries.length, manual};
  for (const q of queries) {
    if (isCancelled() || Date.now() < state.pausedUntil) return false;
    // A near-identical search was done recently: reuse its result instead of asking YouTube again.
    const shared = sharedResult(sibs.get(q.id));
    if (shared) {
      results.push({q, rank: shared.rank, video: shared.video, total: shared.total, top: shared.top ? JSON.parse(shared.top) : null, fresh: shared.fresh ? JSON.parse(shared.fresh) : null, shared: shared.query});
      state.grouped = (state.grouped ?? 0) + 1; state.current.done++;
      continue;
    }
    try {
      const text = resolveQuery(q.query);
      const list = await searchVideos(text).catch(err => { if (/\b429\b/.test(err.message)) throw err; return sleep(jitter(15e3)).then(() => searchVideos(text)); });
      const mine = list.findIndex(v => v.channelIds.includes(cat.channel_id));
      const top = list.slice(0, 5).map(v => ({id: v.id, title: v.title, channel: v.channel, views: v.views, age: v.age, own: v.channelIds.includes(cat.channel_id)}));
      // Newest video anywhere in the results, and your newest, with an approximate publish date.
      const dated = list.map(v => ({v, age: parseAge(v.age)})).filter(x => x.age != null).sort((a, b) => a.age - b.age);
      const pick = x => x && {id: x.v.id, title: x.v.title, channel: x.v.channel, date: iso(Date.now() - x.age), own: x.v.channelIds.includes(cat.channel_id)};
      const fresh = {mine: Object.fromEntries(ownChannels().map(o => [o.id, pick(dated.find(x => x.v.channelIds.includes(o.channel_id)))]).filter(([, v]) => v))};
      results.push({q, rank: mine < 0 ? null : mine + 1, video: mine < 0 ? null : list[mine].id, total: list.length, top, fresh});
      succeeded();
    } catch (err) {
      if (failed(err, alert)) return false;
      results.push({q, error: err.message});
    }
    state.current.done++;
    // Wait in short slices so a manual check or shutdown can interrupt the gap.
    for (const end = Date.now() + jitter(gap()); Date.now() < end && !isCancelled();) await sleep(Math.min(1000, end - Date.now()));
  }
  const status = statusOf(results);
  await batch(() => {
    const ins = db.prepare(`INSERT INTO rank_results (query, ts, rank, video, total, top, error, fresh, shared_from) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const r of results) ins.run(r.q.id, ts, r.rank ?? null, r.video ?? null, r.total ?? null, r.top ? JSON.stringify(r.top) : null, r.error ?? null, r.fresh ? JSON.stringify(r.fresh) : null, r.shared ?? null);
    db.prepare(`UPDATE rank_subcategories SET status=coalesce(?, status), checked_at=? WHERE id=?`).run(status, ts, sub.id);
  });
  // The watchdog turns these results into confirmed incidents (your two rules included) and sends alerts.
  try { await evaluate(sub, cat, ts, alert); } catch (err) { console.error('[dashboard] watchdog failed', err); }
  return true;
}

// Important categories are rechecked every 2 hours, the rest every 8. If that needs more searches than the
// safe pace allows (one per MIN_GAP), everything stretches evenly and the status reports it as behind.
export const IMPORTANT_EVERY = 2 * 3600e3, NORMAL_EVERY = 8 * 3600e3;
// Budgets with open incidents are checked twice as often; calm, strong ones a bit less.
const dueEvery = s => (s.important ? IMPORTANT_EVERY : NORMAL_EVERY) * (s.hot ? 0.5 : s.status === 'strong' ? 1.5 : 1);
function load() {
  const hot = hotSubs(), pending = pendingSubs();
  return db.prepare(`SELECT s.*, c.important, (SELECT count(*) FROM rank_queries q WHERE q.sub=s.id AND q.muted=0) n FROM rank_subcategories s JOIN rank_categories c ON c.id=s.category`).all()
    .map(s => ({...s, hot: hot.has(s.id), pending: pending.has(s.id)}));
}
// Searches per hour needed. Grouped duplicates (non-important categories) count once per group.
function demandPerHour() {
  const g = groups(), seen = new Set();
  let saved = 0;
  for (const [id, others] of g) { if (seen.has(id)) continue; others.forEach(o => seen.add(o)); saved += others.length; }
  const extra = new Map();
  for (const id of seen) { const sub = db.prepare(`SELECT sub FROM rank_queries WHERE id=?`).get(id)?.sub; extra.set(sub, (extra.get(sub) ?? 0) + 1); }
  return load().reduce((a, s) => a + Math.max(0, s.n - (extra.get(s.id) ?? 0)) * 3600e3 / dueEvery(s), 0);
}
export const groupStats = () => { const g = groups(); return {queries: g.size, saved: g.size - new Set([...g].map(([id, o]) => Math.min(id, ...o))).size}; };
// Each node searches from its own connection, so with N nodes each one can go N times slower.
function pace() { const d = demandPerHour(); return Math.max(MIN_GAP, d ? 3600e3 / d * activeWorkers() : MIN_GAP); }
// Most overdue first (relative to its own interval); important, then weak/missing, break ties.
function nextDue(skip = new Set()) {
  const now = Date.now(), rank = {missing: 0, weak: 1, null: 2, strong: 3};
  // Unconfirmed incidents jump the queue so they are confirmed or cleared quickly.
  const over = s => s.pending ? 1e6 : s.checked_at ? (now - new Date(s.checked_at)) / dueEvery(s) : Infinity;
  const taken = heldByOthers('rank:');
  const due = load().filter(s => s.n && over(s) >= 1 && !taken.has('rank:' + s.id));
  return due.filter(s => !skip.has(s.id)).sort((a, b) => over(b) - over(a) || b.important - a.important || (rank[a.status] ?? 2) - (rank[b.status] ?? 2))[0];
}

function schedule(ms) { clearTimeout(state.timer); state.nextAt = Date.now() + ms; state.timer = setTimeout(step, ms); }
async function step(alert = state.alert) {
  state.timer = null;
  if (state.stop) return;
  if (state.manual || state.job) return schedule(15e3);
  if (Date.now() < state.pausedUntil) return schedule(state.pausedUntil - Date.now() + 1000);
  if (!isActive()) { state.current = null; return schedule(60e3); }
  // Take the most overdue budget no other node is checking (a lost race just moves on to the next one).
  let sub = null;
  for (const skip = new Set(); ;) {
    const s = nextDue(skip);
    if (!s) break;
    if (await claim('rank:' + s.id, LEASE_MS)) { sub = s; break; }
    skip.add(s.id);
    if (skip.size > 20) break;
  }
  if (!sub) { state.current = null; return schedule(sub === null && nextDue() ? 60e3 : 10 * 60e3); }
  const g = state.gen;
  state.job = checkSub(sub, alert, pace, () => state.stop || state.gen !== g || !!state.manual || currentMode() === 'disabled')
    .then(ok => { if (ok) countWork('searches', sub.n); })
    .catch(err => console.error('[dashboard] rank check failed', err))
    .finally(() => { release('rank:' + sub.id); if (state.gen === g) { state.job = null; state.current = null; } });
  await state.job;
  schedule(jitter(pace()));
}
export const rankNodeStatus = () => ({current: state.current ? 'Rankings: ' + state.current.name + ` (${state.current.done}/${state.current.total})` : null,
  rateLimitedUntil: Date.now() < (state.pausedUntil ?? 0) ? iso(state.pausedUntil) : null});
export function startRankWorker(alert) {
  // A server restart in the same process (Vite reload) cancels loops from the previous generation.
  myGen = state.gen = (state.gen ?? 0) + 1; state.manual = null; state.job = null; state.current = null;
  state.alert = alert; state.stop = false; schedule(30e3);
}
let myGen = null;
// Only stop the generation this module started (a reloaded module may already have taken over).
export function stopRankWorker() { if (state.gen !== myGen) return; state.stop = true; clearTimeout(state.timer); }

// "Check now" for one category: faster pace, still stops on rate limits. Runs in the background.
export function checkCategory(alert, categoryId, subId) {
  if (state.manual) return;
  const subs = db.prepare(`SELECT * FROM rank_subcategories WHERE ${subId ? 'id=?' : 'category=?'} ORDER BY position, id`).all(subId ?? categoryId);
  if (!subs.length) return;
  if (Date.now() < state.pausedUntil) throw Object.assign(new Error(`YouTube is limiting searches. Checks resume ${new Date(state.pausedUntil).toLocaleTimeString()}.`), {status: 429});
  const total = subs.reduce((a, s) => a + db.prepare(`SELECT count(*) n FROM rank_queries WHERE sub=?`).get(s.id).n, 0);
  state.manual = {category: subs[0].category, sub: subId ?? null, done: 0, total};
  const g = state.gen;
  (async () => {
    await state.job; // let the worker's current budget stop
    for (const s of subs) {
      const ok = await checkSub(s, alert, () => MANUAL_GAP[0] + Math.random() * (MANUAL_GAP[1] - MANUAL_GAP[0]), () => state.stop || state.gen !== g, true);
      state.current = null;
      if (!ok) break;
      state.manual.done += db.prepare(`SELECT count(*) n FROM rank_queries WHERE sub=?`).get(s.id).n;
    }
  })().catch(err => console.error('[dashboard] manual rank check failed', err)).finally(() => { if (state.gen === g) { state.manual = null; state.current = null; } });
}

function workerStatus() {
  const since = iso(Date.now() - RANK_CYCLE);
  const all = db.prepare(`SELECT count(*) n FROM rank_queries`).get().n;
  const fresh = db.prepare(`SELECT count(DISTINCT query) n FROM rank_results WHERE ts>=?`).get(since).n;
  const m = state.manual && {...state.manual, done: state.manual.done + (state.current?.manual ? state.current.done : 0)};
  const demand = demandPerHour(), capacity = 3600e3 / MIN_GAP;
  return {importantHours: IMPORTANT_EVERY / 3600e3, normalHours: NORMAL_EVERY / 3600e3, perHour: Math.round(Math.min(demand, capacity)), behind: demand > capacity ? +(demand / capacity).toFixed(1) : 0, paceSeconds: Math.round(pace() / 1000), total: all, checkedToday: Math.min(fresh, all),
    pausedUntil: Date.now() < state.pausedUntil ? iso(state.pausedUntil) : null, nextAt: state.nextAt ? iso(state.nextAt) : null,
    current: state.current ? {...state.current} : null, manual: m || null, grouping: groupStats()};
}

const ownChannels = () => db.prepare(`SELECT id, channel_id, name, title FROM channels WHERE kind='own'`).all();
// ---------- read model ----------
try { db.exec(`ALTER TABLE rank_results ADD COLUMN fresh TEXT`); } catch {}
try { db.exec(`ALTER TABLE rank_results ADD COLUMN shared_from INTEGER`); } catch {}
const ownPublished = db.prepare(`SELECT published FROM videos WHERE id=?`);
// Newest videos seen in a result. Older results (before this was stored) fall back to the top 5 they kept.
function freshOf(r) {
  if (!r) return null;
  const saved = r.fresh ? JSON.parse(r.fresh) : null;
  if (saved?.mine) return saved;
  // Older rows only kept the top 5: match your channels by name there.
  const top = (r.top ? JSON.parse(r.top) : []).map(t => ({t, age: parseAge(t.age)})).filter(x => x.age != null).sort((a, b) => a.age - b.age);
  const pick = x => x && {id: x.t.id, title: x.t.title, channel: x.t.channel, date: new Date(new Date(r.ts) - x.age).toISOString(), own: true};
  const is = (t, o) => [o.name, o.title].filter(Boolean).some(n => t.channel === n || t.channel.startsWith(n + ' and '));
  return {mine: Object.fromEntries(ownChannels().map(o => [o.id, pick(top.find(x => is(x.t, o)))]).filter(([, v]) => v))};
}
// Per budget: each of your channels' newest upload whose title matches one of the budget's searches.
// Uses your channels' synced uploads, so it costs no YouTube requests and shows the exact publish date.
const STOP = new Set(['best', 'top', 'the', 'a', 'an', 'in', 'for', 'of', 'to', 'and', 'with', 'buy', 'which', 'should', 'you', 'is', 'vs', 'india', 'new', 'latest']);
const tokens = t => String(t ?? '').toLowerCase()
  .replace(/₹|rs\.?\s*|inr/g, ' ').replace(/(\d),(?=\d)/g, '$1')
  .replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, n) => String(Math.round(n * 1000)))
  .replace(/(\d+(?:\.\d+)?)\s*lakhs?\b/g, (_, n) => String(Math.round(n * 100000)))
  .split(/[^a-z0-9]+/).filter(Boolean).map(w => w.length > 3 && w.endsWith('s') && !/\d/.test(w) ? w.slice(0, -1) : w);
const ownUploads = db.prepare(`SELECT id, title, published FROM videos WHERE channel=? AND published IS NOT NULL ORDER BY published DESC`);
function withLatest(s) {
  const qs = s.queries.filter(q => !q.muted).map(q => tokens(q.text ?? q.query).filter(w => !STOP.has(w))).filter(t => t.length);
  const latest = {};
  for (const o of ownChannels()) {
    const v = ownUploads.all(o.id).find(v => { const t = new Set(tokens(v.title)); return qs.some(q => q.every(w => t.has(w))); });
    if (v) latest[o.id] = {id: v.id, title: v.title, channel: o.name, date: new Date(v.published).toISOString(), own: true};
  }
  return {...s, latest};
}

// Compact 7-day summary of a search's positions (instead of sending every check to the browser).
function weekSummary(h) {
  const weekAgo = Date.now() - 7 * 864e5;
  const before = [...h].reverse().find(p => Date.parse(p.ts) <= weekAgo);
  const inWeek = h.filter(p => Date.parse(p.ts) >= weekAgo);
  let moves = 0; for (let i = 1; i < inWeek.length; i++) if (inWeek[i].rank !== inWeek[i - 1].rank) moves++;
  return {history: h.slice(-2).map(x => x.rank), week: {then: (before ?? h[0])?.rank, hasWeek: !!before, steps: Math.max(0, inWeek.length - 1), moves, any: h.length > 0}};
}

export function rankingData() {
  const latest = db.prepare(`SELECT * FROM rank_results WHERE query=? ORDER BY ts DESC LIMIT 1`);
  // Only the last 8 days of positions are sent (enough for the 7-day comparisons); older history stays in the database.
  const history = db.prepare(`SELECT ts, rank FROM rank_results WHERE query=? AND error IS NULL AND ts>=? ORDER BY ts DESC LIMIT 60`), since8 = iso(Date.now() - 8 * 864e5);
  return {
    running: !!state.manual, top: TOP, worker: workerStatus(), watchdog: watchdogData(),
    categories: db.prepare(`SELECT c.*, ch.name channel_name, ch.color FROM rank_categories c JOIN channels ch ON ch.id=c.channel ORDER BY c.position, c.id`).all().map(c => ({
      ...c,
      subs: db.prepare(`SELECT * FROM rank_subcategories WHERE category=? ORDER BY position, id`).all(c.id).map(s => withLatest({
        ...s,
        queries: db.prepare(`SELECT * FROM rank_queries WHERE sub=? ORDER BY position, id`).all(s.id).map(q => {
          const r = latest.get(q.id);
          return {...q, rank: r?.rank ?? null, video: r?.video ?? null, total: r?.total ?? null, error: r?.error ?? null, ts: r?.ts ?? null,
            text: resolveQuery(q.query), dynamic: /\{year\}/i.test(q.query),
            top: r?.top ? JSON.parse(r.top).map(t => ({id: t.id, title: t.title, channel: t.channel, own: t.own})) : [], shared: !!r?.shared_from,
            ...weekSummary(history.all(q.id, since8).reverse())};
        })
      }))
    }))
  };
}

// ---------- HTTP routes (called from api.js) ----------
const clean = (s, max = 80) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
export async function rankingRoutes(route, readJson, alert) {
  const tl = /^GET \/api\/rankings\/queries\/(\d+)\/timeline$/.exec(route);
  if (tl) return {json: queryTimeline(Number(tl[1]))};
  const sn = /^POST \/api\/rankings\/incidents\/(\d+)\/snooze$/.exec(route);
  if (sn) { const {days} = await readJson(); snooze(Number(sn[1]), days == null ? 7 : Number(days)); return true; }
  const mu = /^POST \/api\/rankings\/queries\/(\d+)\/mute$/.exec(route);
  if (mu) { const {muted} = await readJson(); muteQuery(Number(mu[1]), !!muted); return true; }
  if (route === 'POST /api/rankings/check') {
    const {category, sub} = await readJson();
    checkCategory(alert, category ? Number(category) : null, sub ? Number(sub) : null);
    return true;
  }
  const imp = /^POST \/api\/rankings\/categories\/(\d+)\/important$/.exec(route);
  if (imp) { const {important} = await readJson(); db.prepare(`UPDATE rank_categories SET important=? WHERE id=?`).run(important ? 1 : 0, Number(imp[1])); return true; }
  if (route === 'POST /api/rankings/categories') {
    const {name, channel} = await readJson();
    if (!clean(name)) throw Object.assign(new Error('Give the category a name.'), {status: 400});
    if (!db.prepare(`SELECT 1 FROM channels WHERE id=? AND kind='own'`).get(Number(channel))) throw Object.assign(new Error('Choose one of your channels.'), {status: 400});
    db.prepare(`INSERT INTO rank_categories (name, channel, position) VALUES (?,?,(SELECT coalesce(max(position),0)+1 FROM rank_categories))`).run(clean(name), Number(channel));
    return true;
  }
  if (route === 'POST /api/rankings/subcategories') {
    const {id, category, name, queries} = await readJson();
    const list = [...new Set((Array.isArray(queries) ? queries : String(queries ?? '').split('\n')).map(q => clean(q, 120).toLowerCase().replace(/\{year\}/g, '{year}')).filter(Boolean))].slice(0, 12);
    if (!clean(name)) throw Object.assign(new Error('Give the subcategory a name.'), {status: 400});
    if (!list.length) throw Object.assign(new Error('Add at least one search query.'), {status: 400});
    tx(() => {
      let sub = Number(id);
      if (sub) db.prepare(`UPDATE rank_subcategories SET name=? WHERE id=?`).run(clean(name), sub);
      else {
        if (!db.prepare(`SELECT 1 FROM rank_categories WHERE id=?`).get(Number(category))) throw Object.assign(new Error('Unknown category.'), {status: 400});
        sub = db.prepare(`INSERT INTO rank_subcategories (category, name, position) VALUES (?,?,(SELECT coalesce(max(position),0)+1 FROM rank_subcategories WHERE category=?))`).run(Number(category), clean(name), Number(category)).lastInsertRowid;
      }
      // Keep existing queries (and their history) that are still listed; add new ones; drop removed ones.
      const existing = db.prepare(`SELECT id, query FROM rank_queries WHERE sub=?`).all(sub);
      for (const q of existing) if (!list.includes(q.query)) db.prepare(`DELETE FROM rank_queries WHERE id=?`).run(q.id);
      list.forEach((q, i) => {
        const found = existing.find(e => e.query === q);
        if (found) db.prepare(`UPDATE rank_queries SET position=? WHERE id=?`).run(i, found.id);
        else db.prepare(`INSERT INTO rank_queries (sub, query, position) VALUES (?,?,?)`).run(sub, q, i);
      });
    });
    return true;
  }
  const delCat = /^DELETE \/api\/rankings\/categories\/(\d+)$/.exec(route);
  if (delCat) { db.prepare(`DELETE FROM rank_categories WHERE id=?`).run(Number(delCat[1])); return true; }
  const delSub = /^DELETE \/api\/rankings\/subcategories\/(\d+)$/.exec(route);
  if (delSub) { db.prepare(`DELETE FROM rank_subcategories WHERE id=?`).run(Number(delSub[1])); return true; }
  return false;
}
