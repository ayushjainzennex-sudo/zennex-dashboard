// Ranking watchdog: turns raw search results into confirmed incidents with a lifecycle (pending → open → resolved),
// per-budget health scores, a rival board and per-query timelines. Runs after every budget check.
import {db, tx, batch} from './db.js';
import {parseAge} from './youtube.js';

export const TOP = 2;
const DAY = 864e5, iso = (t = Date.now()) => new Date(t).toISOString();
export const RULES = {drop: 3, risingDays: 14, ageingMonths: 9, rivalQueries: 3, unstableSwing: 4, confirmAfterMin: 20, snoozeDays: 7};
export const SEVERITY = {missing: 'critical', weak: 'critical', lost1: 'high', drop: 'high', rising: 'medium', rival: 'medium', ageing: 'medium', split: 'info', unstable: 'info'};
const PUSH = new Set(['critical', 'high']); // sent to Discord/Slack at once; medium goes to the digest, info stays on the dashboard
const NEEDS_CONFIRM = new Set(['critical', 'high', 'medium']);

try { db.exec(`ALTER TABLE rank_queries ADD COLUMN muted INTEGER NOT NULL DEFAULT 0`); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS rank_incidents (
    id INTEGER PRIMARY KEY,
    sub INTEGER NOT NULL REFERENCES rank_subcategories(id) ON DELETE CASCADE,
    key TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL,
    state TEXT NOT NULL,                      -- pending | open | resolved
    title TEXT NOT NULL, details TEXT,
    opened TEXT NOT NULL, last_seen TEXT NOT NULL, resolved TEXT,
    snoozed_until TEXT, notified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS rank_incidents_active ON rank_incidents(sub, state);
`);

// Rough share of clicks each position gets; drives the 0–100 health score.
export const posWeight = r => r == null ? 0 : r === 1 ? 100 : r === 2 ? 60 : r === 3 ? 45 : r <= 5 ? 25 : r <= 10 ? 10 : 0;
const scoreOf = ranks => ranks.length ? Math.round(ranks.reduce((a, r) => a + posWeight(r), 0) / ranks.length) : null;

// Score per check over the last 7 days (one point per check of the budget).
export function scoreSeries(subId, days = 7) {
  const rows = db.prepare(`SELECT r.ts, r.rank FROM rank_results r JOIN rank_queries q ON q.id=r.query
    WHERE q.sub=? AND q.muted=0 AND r.error IS NULL AND r.ts>=? ORDER BY r.ts`).all(subId, iso(Date.now() - days * DAY));
  const by = new Map();
  for (const r of rows) (by.get(r.ts) ?? by.set(r.ts, []).get(r.ts)).push(r.rank);
  return [...by].map(([ts, ranks]) => ({ts, score: scoreOf(ranks)}));
}

const recent = db.prepare(`SELECT ts, rank, video, top FROM rank_results WHERE query=? AND error IS NULL AND ts>=? ORDER BY ts DESC LIMIT 12`);
const publishedQ = db.prepare(`SELECT published, title FROM videos WHERE id=?`);

// Everything that is wrong with a budget right now, as {key, type, title, details}.
function conditions(sub, cat) {
  const queries = db.prepare(`SELECT * FROM rank_queries WHERE sub=? AND muted=0 ORDER BY position, id`).all(sub.id);
  const since = iso(Date.now() - 7 * DAY), found = [];
  const qs = queries.map(q => {
    const hist = recent.all(q.id, since).map(h => ({...h, top: h.top ? JSON.parse(h.top) : []}));
    return {q, now: hist[0], hist};
  }).filter(x => x.now);
  if (!qs.length) return found;
  const label = `${cat.name} · ${sub.name}`;
  const above = x => x.now.top.filter((t, i) => !t.own && i < (x.now.rank ?? 99) - 1).slice(0, 3);
  const qInfo = x => ({id: x.q.id, text: x.q.query.replace(/\{year\}/gi, new Date().getFullYear()), rank: x.now.rank, best: Math.min(...x.hist.map(h => h.rank ?? 99)), above: above(x)});

  // Your two rules.
  const inTop = qs.filter(x => x.now.rank != null && x.now.rank <= TOP).length;
  if (!qs.some(x => x.now.rank != null))
    found.push({type: 'missing', title: `${cat.channel_name} not ranking for ${label}`, details: {queries: qs.map(qInfo), checked: qs.length}});
  else if (inTop <= qs.length / 2)
    found.push({type: 'weak', title: `${cat.channel_name} out of the top ${TOP} for ${label}`, details: {inTop, checked: qs.length, queries: qs.filter(x => !(x.now.rank <= TOP)).map(qInfo)}});

  // Lost #1: held #1 in the last 7 days, not now.
  const lost = qs.filter(x => x.now.rank !== 1 && x.hist.slice(1).some(h => h.rank === 1));
  if (lost.length) found.push({type: 'lost1', title: `Lost #1 on ${lost.length} search${lost.length > 1 ? 'es' : ''} · ${label}`,
    details: {queries: lost.map(x => ({...qInfo(x), takenBy: x.now.top[0]}))}});

  // Sharp drop vs the 7-day best (excluding lost-#1 queries).
  const drop = qs.filter(x => !lost.includes(x)).filter(x => {
    const best = Math.min(...x.hist.map(h => h.rank ?? 99)), now = x.now.rank ?? 99;
    return best < 99 && (now - best >= RULES.drop || (best <= TOP && now > TOP));
  });
  if (drop.length) found.push({type: 'drop', title: `${drop.length} search${drop.length > 1 ? 'es' : ''} dropped · ${label}`, details: {queries: drop.map(qInfo)}});

  // Rising threat: fresh competitor video in the top 3, above you.
  const rising = new Map();
  for (const x of qs) x.now.top.slice(0, 3).forEach((t, i) => {
    const age = parseAge(t.age);
    if (!t.own && age != null && age < RULES.risingDays * DAY && i + 1 < (x.now.rank ?? 99))
      (rising.get(t.id) ?? rising.set(t.id, {video: t, queries: []}).get(t.id)).queries.push({text: x.q.query, pos: i + 1});
  });
  if (rising.size) found.push({type: 'rising', title: `New competitor video${rising.size > 1 ? 's' : ''} climbing · ${label}`, details: {videos: [...rising.values()]}});

  // Repeat rival: one channel above you on several searches.
  const rivals = new Map();
  for (const x of qs) for (const t of above(x).concat(x.now.top.filter((t, i) => !t.own && i >= 3 && i < (x.now.rank ?? 99) - 1)))
    (rivals.get(t.channel) ?? rivals.set(t.channel, new Set()).get(t.channel)).add(x.q.id);
  // One incident per budget: channels above you on at least 3 searches and at least half of them.
  const strongRivals = [...rivals].filter(([, set]) => set.size >= RULES.rivalQueries && set.size >= qs.length / 2).sort((a, b) => b[1].size - a[1].size);
  if (strongRivals.length) found.push({type: 'rival', title: `${strongRivals[0][0]}${strongRivals.length > 1 ? ` +${strongRivals.length - 1}` : ''} outranks ${cat.channel_name} on most searches · ${label}`,
    details: {rivals: strongRivals.slice(0, 3).map(([channel, set]) => ({channel, count: set.size})), of: qs.length}});

  // Which of your videos rank here. Splitting only matters when the budget is under target.
  const mine = new Map();
  for (const x of qs) if (x.now.video) mine.set(x.now.video, (mine.get(x.now.video) ?? 0) + 1);
  if (mine.size >= 2 && inTop <= qs.length / 2) found.push({type: 'split', title: `${mine.size} of your videos split this budget · ${label}`,
    details: {videos: [...mine].map(([id, n]) => ({id, n, title: publishedQ.get(id)?.title ?? null}))}});

  // Ageing: your main video is old and the score is sliding.
  const main = [...mine].sort((a, b) => b[1] - a[1])[0]?.[0];
  const pub = main && publishedQ.get(main)?.published;
  if (pub && Date.now() - new Date(pub) > RULES.ageingMonths * 30 * DAY) {
    const series = scoreSeries(sub.id);
    if (series.length >= 3 && series[0].score - series.at(-1).score >= 10)
      found.push({type: 'ageing', title: `Your ${label} video is ${Math.round((Date.now() - new Date(pub)) / (30 * DAY))} months old and slipping`,
        details: {video: main, title: publishedQ.get(main)?.title, published: pub, from: series[0].score, to: series.at(-1).score}});
  }

  // Unstable: rank swinging.
  const unstable = qs.filter(x => x.hist.length >= 4).filter(x => { const r = x.hist.slice(0, 6).map(h => h.rank ?? 21); return Math.max(...r) - Math.min(...r) >= RULES.unstableSwing; });
  if (unstable.length) found.push({type: 'unstable', title: `${unstable.length} search${unstable.length > 1 ? 'es' : ''} unstable · ${label}`,
    details: {queries: unstable.map(x => ({...qInfo(x), ranks: x.hist.slice(0, 6).map(h => h.rank).reverse()}))}});

  return found.map(f => ({...f, key: f.key ?? f.type}));
}

const describe = i => {
  const d = i.details ?? {};
  if (d.queries?.length) return d.queries.slice(0, 4).map(q => `“${q.text}”: ${q.rank ? '#' + q.rank : 'not found'}${q.takenBy ? ` (now #1: ${q.takenBy.channel} youtu.be/${q.takenBy.id})` : q.above?.[0] ? ` (top: ${q.above[0].channel})` : ''}`).join('\n');
  if (d.videos?.length && d.videos[0].video) return d.videos.slice(0, 3).map(v => `${v.video.channel}: “${v.video.title}” (${v.video.age}) youtu.be/${v.video.id}`).join('\n');
  return '';
};

// Compact, structured version of an incident for Discord/Slack (see notify.js `rich`).
const LABEL = {missing: 'Not ranking', weak: 'Out of the top 2', lost1: 'Lost #1', drop: 'Rank drop', rising: 'New competitor video', rival: 'Outranked', ageing: 'Ageing video'};
const cleanCh = c => String(c ?? '').replace(/ and \d+ more$/, '');
export function richOf(i, where, channel, resolved = false) {
  const d = (typeof i.details === 'string' ? JSON.parse(i.details) : i.details) ?? {};
  const lines = [];
  if (d.queries) for (const q of d.queries) lines.push({rank: q.rank ? '#' + q.rank : '–', text: q.text,
    note: q.takenBy ? 'taken by ' + cleanCh(q.takenBy.channel) : q.above?.[0] ? cleanCh(q.above[0].channel) + ' leads' : '',
    url: q.takenBy ? 'https://youtu.be/' + q.takenBy.id : q.above?.[0] ? 'https://youtu.be/' + q.above[0].id : null});
  if (d.videos?.[0]?.video) for (const v of d.videos) lines.push({rank: '#' + Math.min(...v.queries.map(q => q.pos)), text: v.video.title, note: cleanCh(v.video.channel) + ' · ' + v.video.age, url: 'https://youtu.be/' + v.video.id});
  if (d.rivals) for (const r of d.rivals) lines.push({rank: r.count + '/' + d.of, text: cleanCh(r.channel), note: 'searches above you'});
  if (d.video && d.published) lines.push({rank: '', text: d.title ?? d.video, note: 'published ' + new Date(d.published).toLocaleDateString('en-IN', {month: 'short', year: 'numeric'}), url: 'https://youtu.be/' + d.video});
  const summary = resolved ? 'Back on target.' : i.type === 'weak' ? `Top ${TOP} on ${d.inTop} of ${d.checked} searches` : i.type === 'missing' ? `No ${channel} video in the results for ${d.checked} searches` : '';
  return {severity: resolved ? 'resolved' : i.severity, heading: `${resolved ? 'Recovered' : LABEL[i.type] ?? i.type} · ${where}`, summary,
    lines: resolved ? [] : lines.slice(0, 3), more: resolved ? 0 : Math.max(0, lines.length - 3), footer: `${channel} · search rankings`};
}

// Called after each budget check with the results that were just saved.
export async function evaluate(sub, cat, ts, alert) {
  const now = conditions(sub, cat);
  const active = db.prepare(`SELECT * FROM rank_incidents WHERE sub=? AND state IN ('pending','open')`).all(sub.id);
  const byKey = new Map(active.map(i => [i.key, i]));
  const where = `${cat.name} › ${sub.name}`;
  const push = (i, title, body, resolved = false) => {
    const snoozed = i.snoozed_until && new Date(i.snoozed_until) > Date.now();
    alert('ranking', cat.channel, null, title, body, {push: PUSH.has(i.severity) && !snoozed, rich: richOf(i, where, cat.channel_name, resolved)});
  };
  await batch(() => {
    for (const c of now) {
      const sev = SEVERITY[c.type], prev = byKey.get(c.key), details = JSON.stringify(c.details);
      if (!prev) {
        const confirm = NEEDS_CONFIRM.has(sev);
        db.prepare(`INSERT INTO rank_incidents (sub, key, type, severity, state, title, details, opened, last_seen) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(sub.id, c.key, c.type, sev, confirm ? 'pending' : 'open', c.title, details, ts, ts);
        continue;
      }
      byKey.delete(c.key);
      db.prepare(`UPDATE rank_incidents SET title=?, details=?, last_seen=?, state='open' WHERE id=?`).run(c.title, details, ts, prev.id);
      if (prev.state === 'pending') { // seen on two checks in a row: confirmed
        const inc = {...prev, details: c.details};
        if (sev !== 'info') { push(inc, c.title, describe(inc)); db.prepare(`UPDATE rank_incidents SET notified=1 WHERE id=?`).run(prev.id); }
      }
    }
    for (const gone of byKey.values()) {
      db.prepare(`UPDATE rank_incidents SET state='resolved', resolved=? WHERE id=?`).run(ts, gone.id);
      if (gone.notified) push(gone, 'Resolved: ' + gone.title, '', true);
    }
    // Keep the table small.
    db.prepare(`DELETE FROM rank_incidents WHERE state='resolved' AND resolved < ?`).run(iso(Date.now() - 30 * DAY));
  });
}

// Budgets with an unconfirmed incident get rechecked early, once the confirm delay has passed.
export const pendingSubs = () => new Set(db.prepare(`SELECT DISTINCT sub FROM rank_incidents WHERE state='pending' AND last_seen <= ?`).all(iso(Date.now() - RULES.confirmAfterMin * 60e3)).map(r => r.sub));
export const hotSubs = () => new Set(db.prepare(`SELECT DISTINCT sub FROM rank_incidents WHERE state='open' AND (severity<>'info' OR type='unstable')`).all().map(r => r.sub));

const parse = i => ({...i, details: i.details ? JSON.parse(i.details) : null, snoozed: !!i.snoozed_until && new Date(i.snoozed_until) > Date.now()});
// The browser only shows the leading competitor per search, so the rest is left out of the page data.
const pick = t => t && {id: t.id, title: t.title, channel: t.channel};
const slim = i => !i.details?.queries ? i : {...i, details: {...i.details, queries: i.details.queries.map(q => ({...q, above: q.above?.length ? [pick(q.above[0])] : q.above, takenBy: pick(q.takenBy) ?? q.takenBy}))}};
export function watchdogData() {
  const incidents = db.prepare(`SELECT i.*, s.name sub_name, s.category FROM rank_incidents i JOIN rank_subcategories s ON s.id=i.sub
    WHERE i.state IN ('pending','open') OR i.resolved >= ? ORDER BY CASE i.state WHEN 'resolved' THEN 1 ELSE 0 END,
    CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, CASE i.state WHEN 'open' THEN 0 ELSE 1 END, i.last_seen DESC`).all(iso(Date.now() - 7 * DAY)).map(parse).map(slim)
    // Keep every open incident, but only the 25 most recently resolved.
    .filter((i, _, all) => i.state !== 'resolved' || all.filter(x => x.state === 'resolved').indexOf(i) < 25);
  // Rival board: channels above you on the latest result of each query.
  const latest = db.prepare(`SELECT q.id, q.sub, r.rank, r.top FROM rank_queries q JOIN rank_results r ON r.rowid=(SELECT rowid FROM rank_results WHERE query=q.id AND error IS NULL ORDER BY ts DESC LIMIT 1) WHERE q.muted=0`).all();
  const board = new Map();
  for (const r of latest) {
    const top = r.top ? JSON.parse(r.top) : [];
    top.forEach((t, i) => {
      if (t.own || i + 1 >= (r.rank ?? 99)) return;
      const e = board.get(t.channel) ?? board.set(t.channel, {channel: t.channel, queries: 0, firsts: 0, subs: new Set(), videos: new Map()}).get(t.channel);
      e.queries++; if (i === 0) e.firsts++; e.subs.add(r.sub);
      e.videos.set(t.id, (e.videos.get(t.id) ?? {id: t.id, title: t.title, n: 0})); e.videos.get(t.id).n++;
    });
  }
  const rivals = [...board.values()].sort((a, b) => b.queries - a.queries).slice(0, 10)
    .map(e => ({channel: e.channel, queries: e.queries, firsts: e.firsts, budgets: e.subs.size, top: [...e.videos.values()].sort((a, b) => b.n - a.n)[0]}));
  return {incidents, rivals, rules: RULES};
}

export function queryTimeline(id) {
  return db.prepare(`SELECT ts, rank, top FROM rank_results WHERE query=? AND error IS NULL ORDER BY ts DESC LIMIT 60`).all(id).reverse()
    .map(r => { const top = r.top ? JSON.parse(r.top) : []; return {ts: r.ts, rank: r.rank, leader: top[0] ? {channel: top[0].channel, own: top[0].own, id: top[0].id, title: top[0].title} : null}; });
}

export function snooze(id, days) {
  db.prepare(`UPDATE rank_incidents SET snoozed_until=? WHERE id=?`).run(days ? iso(Date.now() + days * DAY) : null, id);
}
export const muteQuery = (id, muted) => db.prepare(`UPDATE rank_queries SET muted=? WHERE id=?`).run(muted ? 1 : 0, id);

export function digestLines() {
  const rows = db.prepare(`SELECT i.title, i.severity FROM rank_incidents i WHERE i.state='open' AND i.severity IN ('critical','high','medium') ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END`).all();
  return rows.length ? [`• Watchdog: ${rows.length} open incident${rows.length > 1 ? 's' : ''}`, ...rows.slice(0, 6).map(r => `   – ${r.title}`)] : [];
}
