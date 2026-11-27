// Topic research, database part (nodes only): competitor and own videos about a topic, scored like the outliers
// (views ÷ that channel's median for the same format). Part of the topic-research feature: see RESEARCH.md.
import {db} from './db.js';
import {tokens, ideas, score} from './research.js';

const median = l => { if (!l.length) return null; const a = [...l].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
let pool = null, poolAt = 0;
function videos() {   // the last 2 years of stored uploads, each with its outlier score; refreshed every 10 minutes
  if (pool && Date.now() - poolAt < 10 * 60e3) return pool;
  const since = new Date(Date.now() - 730 * 864e5).toISOString();
  const rows = db.prepare(`SELECT v.id, v.title, v.short, v.published, v.views, c.id channel, c.name, c.kind, c.color
    FROM videos v JOIN channels c ON c.id=v.channel WHERE v.views IS NOT NULL AND v.published >= ?`).all(since);
  const base = new Map();
  for (const r of rows) { const k = r.channel + ':' + (r.short ? 1 : 0); (base.get(k) ?? base.set(k, []).get(k)).push(r.views); }
  const med = new Map([...base].map(([k, l]) => [k, l.length >= 3 ? median(l) : null]));
  pool = rows.map(r => { const m = med.get(r.channel + ':' + (r.short ? 1 : 0)); return {...r, short: !!r.short, score: m ? r.views / m : null, words: new Set(tokens(r.title ?? ''))}; });
  poolAt = Date.now();
  return pool;
}
// Videos whose title contains most of the topic's words.
export function onTopic(q, need = .6) {
  const STOP = new Set(['the', 'and', 'for', 'with', 'under', 'best', 'top', 'how', 'what', 'why', 'which', 'you', 'your', 'from', 'this', 'that', 'are', 'vs']);
  const all = tokens(q), w = all.filter(t => !STOP.has(t)).length ? all.filter(t => !STOP.has(t)) : all; if (!w.length) return [];
  return videos().filter(v => w.filter(t => v.words.has(t) || v.words.has(t + 's') || (t.endsWith('s') && v.words.has(t.slice(0, -1)))).length >= Math.max(1, Math.ceil(w.length * need)))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 30)
    .map(({words, ...v}) => v);
}

export async function ideasWithDb(seed, geo) {
  const out = await ideas(seed, geo);
  const outliers = onTopic(seed, .5).filter(v => v.kind === 'competitor' && v.score >= 1.5).slice(0, 12);
  return {...out, outliers};
}
export async function scoreWithDb(q, geo) {
  return {...await score(q, geo), coverage: onTopic(q)};
}

// ---------- saved ideas (step 2) ----------
// Stored in settings as research.saved = [{q, geo, status, notes, total, verdict, history:[{at,total}], savedAt, scoredAt, plan}].
// Saved topics older than 7 days are re-scored a few at a time when the list is opened.
import {remoteAll, remoteRun} from './db.js';
import {score as scoreTopic, angles} from './research.js';
const KEY = 'research.saved', STATUSES = ['Idea', 'Researching', 'Approved', 'Dropped'];
const readSaved = async () => { const v = (await remoteAll(`SELECT value FROM settings WHERE key=?`, [KEY]))[0]?.value; try { return v ? JSON.parse(v) : []; } catch { return []; } };
const writeSaved = list => remoteRun(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [KEY, JSON.stringify(list)]);
let rescoring = false;
async function rescore() {
  if (rescoring) return; rescoring = true;
  try {
    const due = (await readSaved()).filter(s => s.status !== 'Dropped' && Date.now() - Date.parse(s.scoredAt ?? 0) > 7 * 864e5).slice(0, 3);
    for (const s of due) {
      const c = await scoreTopic(s.q, s.geo).catch(() => null); if (!c) continue;
      const list = await readSaved(), it = list.find(x => x.q === s.q && x.geo === s.geo); if (!it) continue;
      Object.assign(it, {total: c.total, verdict: c.verdict, scoredAt: new Date().toISOString(), history: [...(it.history ?? []), {at: new Date().toISOString(), total: c.total}].slice(-26)});
      await writeSaved(list);
    }
  } finally { rescoring = false; }
}
export async function savedIdeas() { rescore().catch(() => {}); return readSaved(); }
export async function saveIdea(p) {
  const q = String(p?.q ?? '').toLowerCase().trim().slice(0, 100), geo = String(p?.geo ?? 'IN').slice(0, 5);
  if (!q) throw Object.assign(new Error('Missing topic.'), {status: 400});
  const list = await readSaved(), now = new Date().toISOString();
  let it = list.find(x => x.q === q && x.geo === geo);
  if (!it) { it = {q, geo, status: 'Idea', notes: '', savedAt: now, history: []}; list.unshift(it); if (list.length > 300) list.pop(); }
  if (STATUSES.includes(p.status)) it.status = p.status;
  if (typeof p.notes === 'string') it.notes = p.notes.slice(0, 1000);
  if (typeof p.plan === 'string') it.plan = p.plan.slice(0, 64);
  // Gemini's output kept with the idea: the AI brief and/or the AI pick it came from (brief: null removes it)
  const fit = (v, max) => { const t = JSON.stringify(v); return t.length <= max ? JSON.parse(t) : null; };
  if (p.brief === null) delete it.brief; else if (p.brief && typeof p.brief === 'object') it.brief = fit(p.brief, 20000) ?? it.brief;
  if (p.pick && typeof p.pick === 'object') it.pick = fit({title: p.pick.title, why: p.pick.why, newBecause: p.pick.newBecause, evidence: p.pick.evidence, kind: p.pick.kind, format: p.pick.format, urgency: p.pick.urgency}, 8000) ?? it.pick;
  if (Number.isFinite(p.total)) { it.total = Math.round(p.total); it.verdict = String(p.verdict ?? '').slice(0, 30); if (!it.scoredAt) { it.scoredAt = now; it.history = [{at: now, total: it.total}]; } }
  await writeSaved(list);
  return list;
}
export async function removeIdea(q, geo) {
  const list = (await readSaved()).filter(x => !(x.q === q && x.geo === geo));
  await writeSaved(list); return list;
}
export const anglesWithDb = (q, geo) => angles(q, geo, onTopic(q).filter(v => v.kind === 'competitor').slice(0, 15));

// ---------- AI picks: topics Gemini suggests on its own, with reasons ----------
// Context sent to Gemini:
//  - channel profiles you write (niche, audience, price bands, what you won't make)
//  - competitor videos taking off lately (only that channel's rivals when picks are for one channel)
//  - your own recent hits and flops, and how each format / price band performs for you
//  - your pipeline (Planner entries not yet published, saved ideas incl. dropped ones) so it doesn't repeat them
//  - your 👍 / 👎 / "made it" votes on earlier picks, so it learns your taste
//  - India's Trending now in Technology / Shopping
// Two steps: brainstorm ~25 candidates, then rank them into 8 against the profile and pipeline. Each pick is then
// scored in the background with the normal scorecard, so the numbers can back it up (or flag it as weak).
// Stored in settings: research.picks = {[channel id | 'all']: {...}}, research.profile, research.feedback.
import {gemini} from './research-ai.js';
import {trending, explore} from './gtrends.js';

// Google Trends for our niches: rising and top YouTube searches in India over the last 3 months, one seed per
// tracked ranking category (Laptop, Tablets, TWS…). Feeds the "trend" kind of pick.
async function nicheTrends(ch) {
  const cats = db.prepare(`SELECT DISTINCT name FROM rank_categories ${ch ? 'WHERE channel=?' : ''}`).all(...(ch ? [ch] : [])).map(r => r.name.toLowerCase());
  const seeds = (cats.length ? cats : ['laptop', 'smartphone', 'earbuds']).slice(0, 6);
  // one at a time with a short pause (Google Trends rate-limits bursts); each niche is kept 6 h
  const res = [];
  for (const q of seeds) {
    const hit = nicheCache.get(q);
    if (hit && Date.now() - hit.at < 6 * 36e5) { res.push(hit.v); continue; }
    const v = await explore({q, geo: 'IN', prop: 'youtube', time: 'today 3-m'}).then(d => {
    const v = d.points.map(p => p.values[0]), half = v.length >> 1, avg = l => l.reduce((a, x) => a + x, 0) / Math.max(1, l.length);
    const a = avg(v.slice(0, half)), b = avg(v.slice(half));
    return {niche: q, interest_change_last_6_weeks: a ? Math.round((b - a) / a * 100) + '%' : 'n/a',
      rising_searches: d.rising.slice(0, 10).map(r => `${r.query} (${r.value})`), top_searches: d.top.slice(0, 6).map(r => r.query)};
    }).catch(() => null);
    if (v) { nicheCache.set(q, {at: Date.now(), v}); res.push(v); }
    await new Promise(r => setTimeout(r, 1200));
  }
  return res;
}
const nicheCache = new Map();
const PICKS = 'research.picks', PROFILE = 'research.profile', FEEDBACK = 'research.feedback';
const DAY = 864e5;
const getJson = async (key, d) => { const v = (await remoteAll(`SELECT value FROM settings WHERE key=?`, [key]))[0]?.value; try { return v ? JSON.parse(v) : d; } catch { return d; } };
const putJson = (key, v) => remoteRun(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, JSON.stringify(v)]);
const ownChannels = () => db.prepare(`SELECT id, name FROM channels WHERE kind='own' ORDER BY position`).all();
const chKey = ch => /^\d+$/.test(String(ch ?? '')) ? String(ch) : 'all';

// ----- profile -----
export async function readProfile() { return {general: '', channels: {}, ...(await getJson(PROFILE, {})), own: ownChannels()}; }
export async function saveProfile(p) {
  const clean = {general: String(p?.general ?? '').slice(0, 2000), channels: {}};
  for (const c of ownChannels()) if (typeof p?.channels?.[c.id] === 'string') clean.channels[c.id] = p.channels[c.id].slice(0, 2000);
  await putJson(PROFILE, clean);
  return {...clean, own: ownChannels()};
}

// ----- feedback on picks -----
export async function votePick({topic, vote, channel, focus}) {
  topic = String(topic ?? '').toLowerCase().slice(0, 100);
  if (!topic || !['up', 'down', 'made', 'none'].includes(vote)) throw Object.assign(new Error('Bad vote.'), {status: 400});
  let list = (await getJson(FEEDBACK, [])).filter(f => f.topic !== topic);
  if (vote !== 'none') list = [{topic, vote, channel: chKey(channel), at: new Date().toISOString()}, ...list].slice(0, 100);
  await putJson(FEEDBACK, list);
  // reflect it on the stored picks too
  const all = await getJson(PICKS, {}), k = pickKey(channel, focus);
  for (const p of all[k]?.picks ?? []) if (p.topic === topic) p.vote = vote === 'none' ? null : vote;
  await putJson(PICKS, all);
  return list;
}

// ----- reading -----
export async function readPicks(channel, focus) {
  const k = pickKey(channel, focus), all = await getJson(PICKS, {}), p = all[k];
  if (p?.scoring && !scoringNow.has(k)) scorePicks(k).catch(() => {});   // resume after a restart
  return p ? {...p, stale: Date.now() - Date.parse(p.at) > DAY, own: ownChannels()} : {picks: [], stale: true, own: ownChannels()};
}

// ----- signals -----
const median2 = l => { if (!l.length) return null; const a = [...l].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const BANDS = [[10000, '≤10k'], [20000, '10–20k'], [30000, '20–30k'], [50000, '30–50k'], [80000, '50–80k'], [150000, '80k–1.5L'], [Infinity, '1.5L+']];
function priceOf(title) {
  const t = title.toLowerCase().replace(/,/g, '');
  const m = t.match(/(?:under|below|within|₹|rs\.?)\s*(\d+(?:\.\d+)?)\s*(k|l|lakh|lac|000)?/);
  if (!m) return null;
  let n = parseFloat(m[1]); const u = m[2];
  if (u === 'k') n *= 1e3; else if (u === 'l' || u === 'lakh' || u === 'lac') n *= 1e5; else if (n < 1000) return null;
  return n;
}
function signals(ch) {
  const now = Date.now(), recent = days => v => v.published && now - Date.parse(v.published) < days * DAY;
  const all = videos();
  const rivalIds = ch ? new Set(db.prepare(`SELECT competitor FROM rivals WHERE own=?`).all(ch).map(r => r.competitor)) : null;
  const rivals = all.filter(v => v.kind === 'competitor' && (!rivalIds || rivalIds.has(v.channel)) && recent(45)(v) && v.score >= 1.8).sort((a, b) => b.score - a.score).slice(0, 25);
  const mineAll = all.filter(v => v.kind === 'own' && (!ch || v.channel === ch) && v.score != null);
  const mine = mineAll.filter(recent(120)).sort((a, b) => b.score - a.score);
  // how formats and price bands do for us (median outlier score over the last year)
  const year = mineAll.filter(recent(365));
  const group = (key) => { const g = {}; for (const v of year) { const k = key(v); if (k) (g[k] ??= []).push(v.score); } return Object.entries(g).filter(([, l]) => l.length >= 3).map(([k, l]) => `${k}: ${l.length} videos, median ${median2(l).toFixed(2)}x usual`); };
  return {
    rivals: rivals.map(v => ({id: v.id, title: v.title, channel: v.name, views: v.views, x: +v.score.toFixed(1), short: v.short, days: Math.round((now - Date.parse(v.published)) / DAY)})),
    myHits: mine.slice(0, 12).map(v => ({id: v.id, title: v.title, channel: v.name, views: v.views, x: +v.score.toFixed(1), short: v.short})),
    myFlops: mine.slice(-6).map(v => ({title: v.title, x: +v.score.toFixed(1)})),
    byFormat: group(v => v.short ? 'Shorts' : 'Long-form'),
    byPrice: group(v => { const p = priceOf(v.title ?? ''); return p ? BANDS.find(([max]) => p <= max)[1] : null; }),
    // titles we and our competitors already made recently, so Gemini doesn't hand them back to us
    madeRecently: all.filter(v => (v.kind === 'own' ? (!ch || v.channel === ch) : (!rivalIds || rivalIds.has(v.channel))) && recent(120)(v))
      .sort((a, b) => Date.parse(b.published) - Date.parse(a.published)).slice(0, 80).map(v => `${v.kind === 'own' ? 'US' : 'RIVAL'}: ${v.title}`),
    byType: group(v => /\bvs\.?\b/i.test(v.title) ? 'Comparisons (X vs Y)' : /best|top\s*\d/i.test(v.title) ? 'Best / Top lists' : /review|unbox/i.test(v.title) ? 'Reviews / unboxings' : null),
  };
}
// Our own search-ranking tracker (Rankings page): per budget, where we rank now vs a week ago, which searches
// we're missing from, and who holds #1. This is the data the dashboard scrapes all day.
function ourRankings(ch) {
  const subs = db.prepare(`SELECT s.id, s.name sub, s.status, c.name cat, ch.name channel FROM rank_subcategories s JOIN rank_categories c ON c.id=s.category
    JOIN channels ch ON ch.id=c.channel ${ch ? 'WHERE c.channel=?' : ''} ORDER BY c.position, s.position`).all(...(ch ? [ch] : []));
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
  const latest = db.prepare(`SELECT q.query, r.rank, r.top FROM rank_queries q JOIN rank_results r ON r.query=q.id AND r.error IS NULL
    AND r.ts=(SELECT max(ts) FROM rank_results WHERE query=q.id AND error IS NULL) WHERE q.sub=? AND q.muted=0`);
  const before = db.prepare(`SELECT min(r.rank) rank FROM rank_queries q JOIN rank_results r ON r.query=q.id AND r.error IS NULL
    WHERE q.sub=? AND r.ts BETWEEN ? AND ?`);
  return subs.map(s => {
    const rows = latest.all(s.id);
    if (!rows.length) return null;
    const ranks = rows.map(r => r.rank).filter(r => r != null);
    const leaders = new Map();
    for (const r of rows) { let t; try { t = JSON.parse(r.top ?? '[]')[0]; } catch {} if (t && !t.own) { const k = t.title; const e = leaders.get(k) ?? {...t, n: 0}; e.n++; leaders.set(k, e); } }
    const lead = [...leaders.values()].sort((a, b) => b.n - a.n)[0];
    const prev = before.get(s.id, new Date(Date.parse(weekAgo) - DAY).toISOString(), weekAgo)?.rank ?? null;
    return {channel: s.channel, topic: `${s.cat} ${s.sub}`, status: s.status ?? 'unchecked',
      our_best_rank: ranks.length ? Math.min(...ranks) : 'not in results', a_week_ago: prev ?? 'not in results / unchecked',
      searches_we_rank_top2: `${ranks.filter(r => r <= 2).length} of ${rows.length}`,
      missing_from: rows.filter(r => r.rank == null).map(r => r.query).slice(0, 4),
      beating_us: lead ? `"${lead.title}" by ${lead.channel}, ${lead.views ?? '?'} views, ${lead.age ?? '?'} (#1 on ${lead.n} searches)` : null};
  }).filter(Boolean);
}

async function pipeline(ch) {
  const plans = db.prepare(`SELECT p.title, p.status, p.format, c.name channel FROM plans p LEFT JOIN channels c ON c.id=p.channel WHERE p.status != 'Published' ${ch ? 'AND p.channel=?' : ''} ORDER BY p.created_at DESC LIMIT 40`).all(...(ch ? [ch] : []));
  const saved = await readSaved();
  return {
    plans: plans.map(p => `${p.title} (${p.status}, ${p.format}${p.channel ? ', ' + p.channel : ''})`),
    saved: saved.filter(s => s.status !== 'Dropped').slice(0, 30).map(s => `${s.q} (${s.status}${s.notes ? ': ' + s.notes.slice(0, 80) : ''})`),
    dropped: saved.filter(s => s.status === 'Dropped').slice(0, 15).map(s => s.q + (s.notes ? ': ' + s.notes.slice(0, 80) : '')),
  };
}

// ----- making picks -----
const making = new Map();
// Kinds of pick. "Mix" asks for some of each; a focus asks for 8 of one kind (stored separately: '<channel>|<kind>').
const KINDS = {
  fresh: 'new concepts we have never covered, not tied to a budget we track. Explainers, concept comparisons and myth-busting that buyers search for, e.g. "ai laptop vs normal laptop", "oled vs ips for students", "is 8gb ram enough in 2026", "intel ultra vs ryzen ai", "refurbished vs new laptop". Use the signals as inspiration, not as titles to copy',
  gap: 'budgets/searches from OUR YOUTUBE SEARCH RANKINGS where we are weak, missing or slipping, or where an old or weak video holds #1',
  news: 'launches, sales events and news happening now (competitor hits, Trending now)',
  trend: 'searches that are climbing on Google Trends: rising searches, strong momentum in the live ranking data, or a seasonal peak coming up in the next weeks',
};
const MIX = {fresh: [8, 3], gap: [6, 2], news: [5, 1], trend: [6, 2]};   // [candidates, picks] for the mix
const focusOf = f => KINDS[f] ? f : null;
const pickKey = (channel, focus) => chKey(channel) + (focusOf(focus) ? '|' + focus : '');
export function makePicks(channel, focus) {
  focus = focusOf(focus);
  const k = pickKey(channel, focus), ch = chKey(channel) === 'all' ? null : Number(chKey(channel));
  const want = focus ? {[focus]: [25, 8]} : MIX, kindList = Object.keys(KINDS).map(x => `"${x}"`).join(' | ');
  if (making.has(k)) return making.get(k);
  const job = (async () => {
    const [s, pipe, profile, feedback, tr] = await Promise.all([signals(ch), pipeline(ch), getJson(PROFILE, {}), getJson(FEEDBACK, []), trending({geo: 'IN'}).catch(() => null)]);
    const rk = !focus || focus === 'gap' ? ourRankings(ch) : [];   // rankings pull every idea towards gaps, so only for Mix / Ranking gaps
    const nt = !focus || focus === 'trend' ? await nicheTrends(ch) : [];
    const stored = (await getJson(PICKS, {}))[k];
    const history = [...new Set([...(stored?.picks ?? []).map(p => p.topic), ...(stored?.history ?? [])])].slice(0, 60);
    const own = ownChannels(), name = ch ? own.find(c => c.id === ch)?.name : null;
    const trends = (tr?.items ?? []).filter(i => i.categories.some(c => [18, 16].includes(c))).slice(0, 25)
      .map(i => ({title: i.title, volume: i.volume, increase: i.increase, related: i.terms.slice(0, 4), active: !i.ended, category: i.categories.includes(18) ? 'Technology' : 'Shopping'}));
    const profiles = [profile.general && `About us: ${profile.general}`, ...own.filter(c => (!ch || c.id === ch) && profile.channels?.[c.id]).map(c => `${c.name}: ${profile.channels[c.id]}`)].filter(Boolean);
    const votes = feedback.filter(f => k === 'all' || f.channel === k || f.channel === 'all').slice(0, 30);
    const context = `WHO WE ARE
${profiles.length ? profiles.join('\n') : 'An Indian tech YouTube channel network (phones, laptops, gadgets, buying guides; audience in India). No detailed profile given.'}
${name ? `These picks are for the channel "${name}" only.` : `Our channels: ${own.map(c => c.name).join(', ')}.`}

WHAT WORKS FOR US (last 12 months, median outlier score; 1x = usual, higher is better)
By format: ${s.byFormat.join('; ') || 'not enough data'}
By price band in the title: ${s.byPrice.join('; ') || 'not enough data'}
By video type: ${s.byType.join('; ') || 'not enough data'}
Our best recent videos: ${JSON.stringify(s.myHits)}
Our weakest recent videos: ${JSON.stringify(s.myFlops)}

OUR YOUTUBE SEARCH RANKINGS (tracked all day; best position of our video for each budget's searches, target is top 2)
Weak or missing budgets, slipping ranks and old #1 videos are the biggest opportunities: a new, better video there can take the top spot.
${rk.length ? JSON.stringify(rk) : 'no ranking data'}

ALREADY IN OUR PIPELINE (do not suggest these again; follow-ups or new angles are fine if clearly different)
Planner: ${JSON.stringify(pipe.plans)}
Saved ideas: ${JSON.stringify(pipe.saved)}
Ideas we dropped (we did NOT want these; avoid similar): ${JSON.stringify(pipe.dropped)}

OUR REACTIONS TO EARLIER SUGGESTIONS (learn from these: more like 👍 and "made", less like 👎)
${votes.length ? votes.map(f => `${f.vote === 'up' ? '👍' : f.vote === 'down' ? '👎' : 'made'} ${f.topic}`).join('\n') : 'none yet'}

SIGNALS RIGHT NOW
Competitor videos taking off (last 45 days; x = times their channel's usual views): ${JSON.stringify(s.rivals)}
Google Trending now in India, Technology & Shopping: ${JSON.stringify(trends)}
${nt.length ? `Google Trends, YouTube searches in India, last 3 months, for our niches (rising = growing fastest; "Breakout" = new and exploding): ${JSON.stringify(nt)}` : ''}`;

    // Step 1: wide brainstorm
    const {out: step1} = await gemini(`You are the content strategist for this YouTube channel. Using ONLY the context below, brainstorm 25 distinct candidate video topics${focus ? `, ALL of kind "${focus}"` : ''}:
${Object.entries(want).map(([kd, [n]]) => `- ${n} "${kd}": ${KINDS[kd]}.`).join(String.fromCharCode(10))}
Keep each very short.
Do NOT simply repeat the trends, competitor titles or our own past videos back. Combine the signals into ideas we have not made yet: a newer product generation, an uncovered price band, a fresh comparison, a test or question nobody answered, a seasonal angle. A candidate that is a video in MADE RECENTLY with a new year on it does not count.
${context}

MADE RECENTLY (last 4 months; treat as already done, do not suggest again)
${JSON.stringify(s.madeRecently)}

SUGGESTED BEFORE (earlier picks; do not suggest these or close variants again, we want different ideas)
${JSON.stringify(history)}

Answer with JSON only: {"candidates": [{"topic": "short search phrase, lowercase", "kind": ${kindList}, "signal": "which signal(s) above support it"}]}`);
    const candidates = (step1.candidates ?? []).slice(0, 30);

    // Step 1.5: live YouTube ranking for the candidates (who ranks now, how old, how many views, where we stand).
    // 4 at a time, at most ~45 s; whatever finishes in time goes to step 2.
    // score a mix of kinds, not just the first 14 (which would all be one kind)
    const byKind = Object.keys(KINDS).map(kd => candidates.filter(c => c.kind === kd));
    const mixed = []; for (let i = 0; mixed.length < 14 && i < 12; i++) for (const l of byKind) if (l[i]) mixed.push(l[i]);
    for (const c of candidates) if (mixed.length < 14 && !mixed.includes(c)) mixed.push(c);
    const ranking = await rankCandidates(mixed.map(c => c.topic).filter(Boolean), own, 45000);

    // Step 2: rank against the profile, what works for us, the pipeline and our reactions
    const {out, model} = await gemini(`You are the content strategist for this YouTube channel. Below is our context and 25 candidate topics.
${focus ? `ALL 8 picks must be of kind "${focus}": ${KINDS[focus]}. Do not return any other kind.
` : ''}Pick 8 to make NEXT: ${Object.entries(want).map(([kd, [, n]]) => `${n} "${kd}" (${KINDS[kd].split('.')[0].split(',')[0]})`).join(', ')}. Within each kind, judge on: fit with who we are and what works for us (format, price band, video type), strength of the signals (several signals agreeing is best), the LIVE YOUTUBE RANKING below (real demand, old or weak top videos = room for us, a topic owned by one big channel = hard), timing, and that it isn't already in our pipeline or like something we dropped or disliked. Be honest about confidence.
You may sharpen or merge candidates into a better idea, but every pick must be NEW: not a video we or our competitors already made (see MADE RECENTLY), not something in SUGGESTED BEFORE, not a retitle of one with a new year, and not just a trending headline repeated back. Each pick needs a clear reason it beats what currently ranks (newer models, a price band nobody covers, a comparison nobody made, a test nobody ran, a question viewers ask that the top videos skip).
${context}

SUGGESTED BEFORE (do not repeat)
${JSON.stringify(history)}

CANDIDATES
${JSON.stringify(candidates)}

LIVE YOUTUBE RANKING IN INDIA FOR THE CANDIDATES (score 0-100 from our scorecard; top results with views and age; where our channels / competitors rank)
${ranking.length ? JSON.stringify(ranking.map(r => ({topic: r.topic, ...r.summary}))) : 'not available right now'}

Answer with JSON only:
{"picks": [{
  "topic": "a short YouTube search phrase, lowercase, e.g. 'best phone under 30000'",
  "title": "a strong working title in English",
  "why": "2-3 sentences: why this, why now, why it fits US (refer to what works for us and the ranking)",
  "new_because": "one sentence: what this video does that the current top-ranking videos and our past videos don't",
  "evidence": ["each item cites a specific signal or fact above, e.g. a competitor video title with its x and views, a trend with its volume, or our own result"],
  "kind": ${kindList},
  "format": "Long-form" or "Short",
  "urgency": "now" | "this week" | "evergreen",
  "confidence": "high" | "medium" | "low"
}]}`);
    const rankScore = new Map(ranking.filter(r => r.card).map(r => [r.topic, r.card]));
    const ids = new Map([...s.rivals, ...s.myHits].map(v => [v.title, v.id]));
    const prev = (await getJson(PICKS, {}))[k]?.picks ?? [];
    const voted = new Map(feedback.map(f => [f.topic, f.vote]));
    const picks = (out.picks ?? []).slice(0, 10).map(p => ({
      topic: String(p.topic ?? '').toLowerCase().slice(0, 100), title: String(p.title ?? '').slice(0, 120), why: String(p.why ?? '').slice(0, 800), newBecause: String(p.new_because ?? '').slice(0, 300),
      evidence: (Array.isArray(p.evidence) ? p.evidence : []).slice(0, 5).map(e => { const t = String(e).slice(0, 300); const hit = [...ids].find(([title]) => title && t.includes(title.slice(0, 30))); return {text: t, video: hit?.[1] ?? null}; }),
      kind: focus ?? (KINDS[p.kind] ? p.kind : null),
      format: p.format === 'Short' ? 'Short' : 'Long-form', urgency: ['now', 'this week', 'evergreen'].includes(p.urgency) ? p.urgency : 'evergreen',
      confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'medium',
      score: prev.find(x => x.topic === p.topic)?.score ?? rankScore.get(String(p.topic ?? '').toLowerCase()) ?? null, vote: voted.get(String(p.topic ?? '').toLowerCase()) ?? null,
    })).filter(p => p.topic);
    const data = {at: new Date().toISOString(), model, channel: k, picks, history, candidates: candidates.length, scoring: true,
      used: {focus, nicheTrends: nt.length, ranks: rk.length, ranked: ranking.length, made: s.madeRecently.length, rivals: s.rivals.length, myHits: s.myHits.length, trends: trends.length, plans: pipe.plans.length, saved: pipe.saved.length + pipe.dropped.length, votes: votes.length, profile: profiles.length > 0}};
    const all = await getJson(PICKS, {}); all[k] = data; await putJson(PICKS, all);
    scorePicks(k).catch(() => {});
    return {...data, stale: false, own};
  })().finally(() => making.delete(k));
  making.set(k, job);
  return job;
}

// Live YouTube ranking for a list of topics, using the normal scorecard (cached 6 h, so step 3's scoring reuses it).
async function rankCandidates(topics, own, budget) {
  const names = new Map([...own.map(c => [c.name, 'US']), ...db.prepare(`SELECT name FROM channels WHERE kind='competitor'`).all().map(c => [c.name, 'RIVAL'])]);
  const out = [], end = Date.now() + budget, queue = [...new Set(topics.map(t => String(t).toLowerCase()))];
  const worker = async () => {
    while (queue.length && Date.now() < end) {
      const topic = queue.shift();
      const card = await Promise.race([scoreTopic(topic, 'IN'), new Promise(r => setTimeout(r, Math.max(0, end - Date.now())))]).catch(() => null);
      if (!card?.results) continue;
      const ours = card.results.filter(v => names.has(v.channel)).map(v => `${names.get(v.channel)} ${v.channel} at #${v.rank}`);
      out.push({topic, card: {total: card.total, verdict: card.verdict, parts: card.parts},
        summary: {score: card.total, verdict: card.verdict, notes: card.parts.map(x => `${x.label} ${x.value}: ${x.note}`),
          top5: card.results.slice(0, 5).map(v => `#${v.rank} "${v.title}" by ${v.channel}, ${v.views ?? '?'} views, ${v.age ?? '?'}`),
          we_and_rivals_rank: ours.length ? ours : ['none of us in the top 20'], rising_searches: card.related.rising.slice(0, 5).map(r => r.query)}});
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// Scores each pick with the normal scorecard, two at a time, saving as it goes (the page polls while scoring).
const scoringNow = new Set();
async function scorePicks(k) {
  if (scoringNow.has(k)) return; scoringNow.add(k);
  try {
  const todo = ((await getJson(PICKS, {}))[k]?.picks ?? []).filter(p => p.score == null).map(p => p.topic);
  const save = async (topic, sc) => { const all = await getJson(PICKS, {}); const p = all[k]?.picks.find(x => x.topic === topic); if (p) { p.score = sc; await putJson(PICKS, all); } };
  for (let i = 0; i < todo.length; i += 2) {
    await Promise.all(todo.slice(i, i + 2).map(async topic => {
      const c = await scoreTopic(topic, 'IN').catch(() => null);
      await save(topic, c ? {total: c.total, verdict: c.verdict, parts: c.parts.map(p => ({label: p.label, value: p.value}))} : {error: true});
    }));
  }
  const all = await getJson(PICKS, {}); if (all[k]) { all[k].scoring = false; await putJson(PICKS, all); }
  } finally { scoringNow.delete(k); }
}
