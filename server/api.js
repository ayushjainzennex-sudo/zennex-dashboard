// API, hourly batch updater, alerts and analytics. Mounted into Vite's dev and preview servers (see vite.config.js).
import {Ytdl} from '@distube/ytdl-core';
import {randomUUID} from 'node:crypto';
import {checkToken, bearer, isLocal} from './auth.js';
import {compile, match, reply, REPLY, HttpError, readJson} from './router.js';
import {gzipSync} from 'node:zlib';
import {db, tx, batch, nextCompetitorColor, startSync, stopSync} from './db.js';
import {loadChannel, loadUploads, channelPath, searchChannels, searchChannelVideos, onReaderHealth} from './youtube.js';
import {notify, notificationSettings, saveNotification, sendTest, digestSettings, saveDigest, markDigestSent, broadcast} from './notify.js';
import {startRankWorker, stopRankWorker, rankingData, rankingRoutes, rankNodeStatus} from './rankings.js';
import {startHeartbeat, stopHeartbeat, setStatusProvider, claim, isActive, countWork, nodesData, setNodeMode, removeNode, requestUpdate, setAutoUpdate, NODE_ID, NODE_NAME, VERSION} from './cluster.js';
import {digestLines} from './watchdog.js';
import {backupNow, backupSettings, setMirror, startBackups, stopBackups} from './backup.js';
import {dbHealth, runAction, saveDbSettings, startMaintenance, stopMaintenance} from './dbhealth.js';
import {onBeforeRestart} from './updater.js';
import {startSnapshots, stopSnapshots} from './snapshot.js';
import {explore as trendsExplore, trending as trendsTrending} from './gtrends.js';
import {ideasWithDb, scoreWithDb, anglesWithDb, savedIdeas, saveIdea, removeIdea, onTopic, readPicks, makePicks, readProfile, saveProfile, votePick} from './research-db.js';
import {compare as researchCompare} from './research.js';
import {brief as researchBrief} from './research-ai.js';   // topic-research AI brief (RESEARCH.md)   // topic-research (RESEARCH.md)
import {thumbCreators, addThumbCreator, removeThumbCreator, thumbPrefs, saveThumbPrefs} from './thumbs.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
export const INTERVAL = 60 * 60 * 1000;
export const OUTLIER = 2; // views ≥ 2× the channel's median video of the same format
const MILESTONES = [1e3, 5e3, 1e4, 25e3, 5e4, 1e5, 25e4, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8];
const LAUNCH_AGES = [1, 3, 6, 12, 24, 48, 72];
const READERS = {channel: 'channel pages', feed: 'upload feeds', videos: 'Videos tabs', shorts: 'Shorts tabs', search: 'search results', 'channel-search': 'channel search', 'in-channel-search': 'in-channel search'};
const iso = (t = Date.now()) => new Date(t).toISOString();
const yt = new Ytdl();
const state = globalThis.__ytDashboard ??= {running: null, timer: null, firstTimer: null, nextRun: null};

const median = list => { if (!list.length) return null; const a = [...list].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const compactNum = n => new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(n);
const norm = t => (t ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- alerts ----------
const insertAlert = db.prepare(`INSERT INTO alerts (ts, kind, channel, video, title, body) VALUES (?,?,?,?,?,?)`);
// Alerts are only about your own channels; competitor activity stays in the dashboard, not the alert feed.
const isCompetitor = id => id != null && db.prepare(`SELECT kind FROM channels WHERE id=?`).get(id)?.kind === 'competitor';
function alert(kind, channel, video, title, body, {push = true, rich} = {}) {
  if (kind === 'upload' || isCompetitor(channel)) return;
  insertAlert.run(iso(), kind, channel, video ?? null, title, body ?? null);
  if (push) notify({kind, title, body, video, rich});
}

// ---------- scoring ----------
// Outliers within a time window: the baseline is the median views of the same format (video or Short) published in
// the window, and each video's score is its views ÷ that baseline. Uploads under a day old are left out of both
// (their views are still climbing); a format with under 3 uploads in the window gets no score.
function windowOutliers(channelId, from) {
  const since = from && !isNaN(Date.parse(from)) ? new Date(from).toISOString() : '0000';
  const now = Date.now();
  const vids = db.prepare(`SELECT v.id, v.title, v.short, COALESCE(d.published, v.published) published, v.thumbnail, v.views, v.approx
    FROM videos v LEFT JOIN video_dates d ON d.id=v.id WHERE v.channel=? AND v.views IS NOT NULL AND COALESCE(d.published, v.published) >= ?`).all(channelId, since)
    .map(v => ({...v, age: now - Date.parse(v.published)}));
  const ready = vids.filter(v => v.age >= DAY);
  const baseFor = {}; for (const f of [0, 1]) { const list = ready.filter(v => !!v.short === !!f).map(v => v.views); baseFor[f] = list.length >= 3 ? median(list) : null; }
  const scored = vids.map(v => {
    if (v.age < DAY) return {...v, score: null, why: 'new'};
    const baseline = baseFor[v.short ? 1 : 0], score = baseline ? v.views / baseline : null;
    return {...v, score, baseline, outlier: score != null && score >= OUTLIER};
  });
  const n = f => ready.filter(v => !!v.short === !!f).length;
  return {
    count: vids.length, scoredCount: scored.filter(v => v.score != null).length,
    oldest: db.prepare(`SELECT min(published) t FROM videos WHERE channel=?`).get(channelId)?.t ?? null,
    unscored: {new: scored.filter(v => v.why === 'new').length, few: scored.filter(v => v.score == null && v.why !== 'new').length},
    baseline: {video: baseFor[0], short: baseFor[1], videos: n(0), shorts: n(1)},
    outliers: scored.filter(v => v.outlier).sort((a, b) => b.score - a.score).slice(0, 12)
      .map(({id, title, short, published, thumbnail, views, approx, score, baseline, age}) =>
        ({id, title, short: !!short, published, thumbnail, views, approx: !!approx, score, baseline, ageDays: age / DAY, outlier: true}))
  };
}
const poolQ = db.prepare(`SELECT * FROM videos WHERE channel=? AND published IS NOT NULL ORDER BY published DESC LIMIT 80`);
function scorer(pool) {
  return v => {
    const peers = pool.filter(p => p.id !== v.id && !!p.short === !!v.short).map(p => p.views).filter(x => x != null);
    const base = median(peers);
    if (peers.length < 3 || !base) return {score: null, baseline: base, outlier: false, peers: peers.length};
    const score = v.views / base;
    return {score, baseline: base, outlier: score >= OUTLIER, peers: peers.length};
  };
}

// ---------- batch update ----------
async function store(channel, data) {
  const ts = iso();
  const before = db.prepare(`SELECT subscribers, kind, name, (SELECT count(*) FROM channel_snapshots WHERE channel=channels.id) snaps FROM channels WHERE id=?`).get(channel.id);
  const known = new Set(db.prepare(`SELECT id FROM videos WHERE channel=?`).all(channel.id).map(r => r.id));
  await batch(() => {
    db.prepare(`UPDATE channels SET channel_id=?, handle=?, title=?, avatar=?, country=?, joined=?, description=?,
      subscribers=?, total_views=?, video_count=?, updated_at=?, error=NULL WHERE id=?`)
      .run(data.channelId ?? null, data.handle ?? null, data.title ?? null, data.avatar ?? null, data.country ?? null, data.joined ?? null,
        data.description ?? null, data.subscribers, data.totalViews, data.videoCount, ts, channel.id);
    db.prepare(`INSERT INTO channel_snapshots (channel, ts, subscribers, total_views, video_count) VALUES (?,?,?,?,?)`)
      .run(channel.id, ts, data.subscribers, data.totalViews, data.videoCount);
    const upsert = db.prepare(`INSERT INTO videos (id, channel, title, short, published, thumbnail, views, likes, updated_at, approx) VALUES (?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, short=excluded.short, published=excluded.published, views=excluded.views, likes=excluded.likes,
      thumbnail=excluded.thumbnail, updated_at=excluded.updated_at, approx=0`);
    const snap = db.prepare(`INSERT INTO video_snapshots (video, ts, views, likes) VALUES (?,?,?,?)`);
    for (const v of data.recent) {
      if (!v.id) continue;
      upsert.run(v.id, channel.id, v.title, v.short ? 1 : 0, v.published, v.thumbnail, v.views, v.likes, ts);
      snap.run(v.id, ts, v.views, v.likes);
    }
  });
  if (!before?.snaps) return; // first fetch of a channel: no alerts for what already existed
  const name = before.name;
  for (const m of MILESTONES) if (before.subscribers < m && data.subscribers >= m)
    alert('milestone', channel.id, null, `${name} reached ${compactNum(m)} subscribers`, `Now at ${compactNum(data.subscribers)}.`);
  if (before.kind === 'competitor') for (const v of data.recent) if (v.id && !known.has(v.id))
    alert('upload', channel.id, v.id, `${name} uploaded a new ${v.short ? 'Short' : 'video'}`, v.title);
  const pool = poolQ.all(channel.id), score = scorer(pool);
  const alerted = new Set(db.prepare(`SELECT video FROM alerts WHERE kind='outlier' AND channel=?`).all(channel.id).map(r => r.video));
  for (const v of pool) {
    if (alerted.has(v.id) || Date.now() - new Date(v.published) > 7 * DAY) continue;
    const s = score(v);
    if (s.outlier) alert('outlier', channel.id, v.id, `Outlier on ${name}: ${s.score.toFixed(1)}× typical views`, v.title);
  }
}

// Once a day, pull ~30 videos + ~30 Shorts from the channel pages to widen the baseline beyond the 15-item RSS feed.
async function backfill(channel, uploads, deep = false) {
  const now = Date.now(), ts = iso();
  const existing = new Map(db.prepare(`SELECT id, published, views, approx FROM videos WHERE channel=?`).all(channel.id).map(r => [r.id, r]));
  const insert = db.prepare(`INSERT OR IGNORE INTO videos (id, channel, title, short, published, thumbnail, views, likes, updated_at, approx) VALUES (?,?,?,?,?,?,?,NULL,?,1)`);
  const refresh = db.prepare(`UPDATE videos SET views=?, updated_at=? WHERE id=?`);
  const thumb = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  // Shorts carry no date: anchor on Shorts we know from RSS and space the rest by their typical gap.
  const anchors = uploads.shorts.map((s, i) => ({i, t: existing.get(s.id)?.approx === 0 ? new Date(existing.get(s.id).published).getTime() : null})).filter(a => a.t);
  const gaps = anchors.slice(1).map((a, k) => (anchors[k].t - a.t) / (a.i - anchors[k].i)).filter(g => g > 0);
  const gap = median(gaps) ?? DAY;
  await batch(() => {
    for (const v of uploads.videos) {
      const row = existing.get(v.id);
      if (!row && v.ageMs != null) insert.run(v.id, channel.id, v.title, 0, iso(now - v.ageMs), thumb(v.id), v.views, ts);
      else if (row && v.views != null && Math.abs(v.views - row.views) > row.views * 0.05) refresh.run(v.views, ts, v.id);
    }
    uploads.shorts.forEach((s, i) => {
      const row = existing.get(s.id);
      if (row) { if (s.views != null && Math.abs(s.views - row.views) > row.views * 0.05) refresh.run(s.views, ts, s.id); return; }
      const prev = [...anchors].reverse().find(a => a.i < i), next = anchors.find(a => a.i > i);
      const t = prev ? prev.t - (i - prev.i) * gap : next ? next.t + (next.i - i) * gap : now - (i + 1) * gap;
      insert.run(s.id, channel.id, s.title, 1, iso(Math.min(t, now)), thumb(s.id), s.views, ts);
    });
    db.prepare(`UPDATE channels SET backfilled_at=? WHERE id=?`).run(ts, channel.id);
    if (deep) db.prepare(`UPDATE channels SET deep_at=? WHERE id=?`).run(ts, channel.id);
  });
}

async function refreshOne(channel) {
  try {
    await store(channel, await loadChannel(channel.path));
    // Daily: the first page of each tab. Weekly: up to 10 pages (~300 videos and ~300 Shorts), so long outlier
    // windows have a year or so of uploads to compare against.
    const deep = !channel.deep_at || Date.now() - new Date(channel.deep_at) > 7 * DAY;
    if (deep || !channel.backfilled_at || Date.now() - new Date(channel.backfilled_at) > DAY) await backfill(channel, await loadUploads(channel.path, deep ? 10 : 1), deep);
    return true;
  } catch (err) { db.prepare(`UPDATE channels SET error=? WHERE id=?`).run(err.message, channel.id); return false; }
}

// Mark planned videos as published when they appear on the channel (by video id, or a closely matching title).
function syncPlans() {
  const plans = db.prepare(`SELECT * FROM plans WHERE status != 'Published' AND channel IS NOT NULL`).all();
  for (const p of plans) {
    const vids = db.prepare(`SELECT id, title, published FROM videos WHERE channel=? AND published >= ? ORDER BY published DESC`).all(p.channel, p.created_at.slice(0, 10));
    const t = norm(p.title);
    const hit = vids.find(v => v.id === p.youtube_id) ?? (t.length >= 12 ? vids.find(v => { const n = norm(v.title); return n.includes(t) || t.includes(n); }) : null);
    if (!hit) continue;
    db.prepare(`UPDATE plans SET status='Published', youtube_id=?, date=? WHERE id=?`).run(hit.id, hit.published.slice(0, 10), p.id);
    alert('published', p.channel, hit.id, 'Planned video is live', p.title);
  }
}

export function runBatch(trigger) {
  if (state.running) return state.running;
  // Another node sharing this database may already have run this hour.
  const last = db.prepare(`SELECT started_at FROM runs ORDER BY id DESC LIMIT 1`).get()?.started_at;
  if (trigger === 'scheduled' && last && Date.now() - new Date(last) < INTERVAL * 0.8) return Promise.resolve();
  state.running = (async () => {
    // Scheduled updates: exactly one node per hour (the lease); if that node is gone, the next one takes over.
    if (trigger === 'scheduled' && !(isActive() && await claim('updates', INTERVAL * 0.8))) return;
    const run = db.prepare(`INSERT INTO runs (trigger, started_at) VALUES (?, ?)`).run(trigger, iso()).lastInsertRowid;
    const channels = db.prepare(`SELECT * FROM channels ORDER BY kind DESC, position, id`).all();
    let ok = 0;
    for (let i = 0; i < channels.length; i += 3) { // a few at a time to be gentle on YouTube
      ok += (await Promise.all(channels.slice(i, i + 3).map(refreshOne))).filter(Boolean).length;
    }
    try { syncPlans(); } catch (err) { console.error('[dashboard] plan sync failed', err); }
    maybeDigest().catch(err => console.error('[dashboard] digest failed', err.message));
    db.prepare(`UPDATE runs SET finished_at=?, ok=?, failed=? WHERE id=?`).run(iso(), ok, channels.length - ok, run);
    countWork('channels', ok);
    console.log(`[dashboard] ${trigger} update: ${ok}/${channels.length} channels refreshed`);
  })().finally(() => { state.running = null; });
  return state.running;
}

export function startScheduler() {
  stopScheduler();
  startSync();
  setStatusProvider(() => { const r = rankNodeStatus(); return {current: state.running ? 'Updating channels' : r.current, rateLimitedUntil: r.rateLimitedUntil}; });
  startHeartbeat();
  startBackups();
  startMaintenance();
  startRankWorker(alert);
  startSnapshots(dashboard);   // a copy in the shared database for when no node is online
  // Before a self-update restart: stop the background work and hand jobs back.
  onBeforeRestart(stopScheduler);
  // A YouTube page reader failing 3 times in a row (layout change, blocking) shows up in the dashboard's alert feed
  // only; it is never sent to Discord/Slack.
  onReaderHealth(
    (reader, error, fails) => alert('system', null, null, `Can't read YouTube ${READERS[reader] ?? reader} on ${NODE_NAME}`,
      `${fails} failed reads in a row. Last error: ${error}\nIf this keeps happening, YouTube may have changed the page or is limiting this node.`, {push: false}),
    reader => alert('system', null, null, `YouTube ${READERS[reader] ?? reader} readable again on ${NODE_NAME}`, null, {push: false}));
  const last = db.prepare(`SELECT finished_at FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get()?.finished_at;
  const firstIn = !last ? 0 : Math.max(0, INTERVAL - (Date.now() - new Date(last)));
  state.nextRun = Date.now() + firstIn;
  state.firstTimer = setTimeout(() => {
    runBatch('scheduled');
    state.nextRun = Date.now() + INTERVAL;
    state.timer = setInterval(() => { state.nextRun = Date.now() + INTERVAL; runBatch('scheduled'); }, INTERVAL);
  }, firstIn);
}
// ---------- digest ----------
const signed = n => n == null ? '—' : (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString('en-IN');
export function digest(days) {
  const since = iso(Date.now() - days * DAY);
  const own = db.prepare(`SELECT * FROM channels WHERE kind='own' ORDER BY position, id`).all();
  const lines = own.map(raw => {
    const c = {...analytics(raw), id: raw.id, subscribers: raw.subscribers, total_views: raw.total_views, video_count: raw.video_count};
    const first = firstSnap.get(c.id)?.ts, d = delta(c, days * 24) ?? (first ? delta(c, (Date.now() - new Date(first)) / HOUR - 0.01) : null), hits = c.outliers.filter(v => v.published >= since);
    const ups = db.prepare(`SELECT count(*) n FROM videos WHERE channel=? AND published>=?`).get(c.id, since).n;
    return `• ${c.name}: ${d ? signed(d.s) + ' subs, ' + signed(d.v) + ' views' + (d.since > since ? ' (since ' + d.since.slice(5, 10) + ')' : '') : 'collecting data'}, ${ups} upload${ups === 1 ? '' : 's'}` +
      (hits.length ? `, ${hits.length} outlier${hits.length === 1 ? '' : 's'} (best: “${hits[0].title}”, ${hits[0].score.toFixed(1)}×)` : '');
  });
  const subs = rankingData().categories.flatMap(c => c.subs.map(s => ({...s, cat: c.name})));
  const weak = subs.filter(s => s.status === 'weak' || s.status === 'missing');
  if (subs.length) lines.push(`• Rankings: ${subs.length - weak.length}/${subs.length} budgets strong` + (weak.length ? ` · needs work: ${weak.slice(0, 5).map(s => s.name).join(', ')}` : ''));
  const ups = db.prepare(`SELECT count(*) n FROM alerts WHERE kind='upload' AND ts>=?`).get(since).n;
  lines.push(...digestLines());
  if (ups) lines.push(`• Competitors posted ${ups} new video${ups === 1 ? '' : 's'}`);
  return {kind: 'digest', title: `${days === 1 ? 'Daily' : 'Weekly'} digest`, body: lines.join('\n')};
}
async function maybeDigest() {
  const d = digestSettings(), now = new Date();
  if (d.mode === 'off' || now.getHours() < d.hour) return;
  if (d.mode === 'weekly' && now.getDay() !== 1) return; // Mondays
  if (d.last && now - new Date(d.last) < 20 * HOUR) return;
  await broadcast(digest(d.mode === 'weekly' ? 7 : 1));
  markDigestSent();
}

export function stopScheduler() { clearTimeout(state.firstTimer); clearInterval(state.timer); stopRankWorker(); stopBackups(); stopMaintenance(); stopSync(); stopHeartbeat(); stopSnapshots(); }

// ---------- analytics ----------
const snapAt = db.prepare(`SELECT subscribers s, total_views v, video_count n, ts FROM channel_snapshots WHERE channel=? AND ts<=? ORDER BY ts DESC LIMIT 1`);
const firstSnap = db.prepare(`SELECT ts FROM channel_snapshots WHERE channel=? ORDER BY ts LIMIT 1`);
const seriesQ = db.prepare(`SELECT ts, subscribers s, total_views v, video_count n FROM channel_snapshots WHERE channel=? AND ts>=? ORDER BY ts`);
const recentQ = db.prepare(`SELECT * FROM videos WHERE channel=? AND approx=0 ORDER BY published DESC LIMIT 15`);
const videoAt = db.prepare(`SELECT views, ts FROM video_snapshots WHERE video=? AND ts<=? ORDER BY ts DESC LIMIT 1`);
const videoFirst = db.prepare(`SELECT views, ts FROM video_snapshots WHERE video=? ORDER BY ts LIMIT 1`);
const launchSnaps = db.prepare(`SELECT ts, views FROM video_snapshots WHERE video=? AND ts<=? ORDER BY ts`);

// Views gained and uploads for the last 7 days, last 28 days and this calendar month.
// Views come from channel snapshots, so a period older than tracking starts from the first snapshot (`since`).
const uploadsIn = db.prepare(`SELECT count(*) n, sum(short) shorts, sum(views) views, sum(CASE WHEN short THEN views ELSE 0 END) shortViews FROM videos WHERE channel=? AND published>=?`);
const firstAfter = db.prepare(`SELECT total_views v, ts FROM channel_snapshots WHERE channel=? AND ts>=? ORDER BY ts LIMIT 1`);
function periods(c) {
  const now = new Date(), month = new Date(now.getFullYear(), now.getMonth(), 1);
  return [['7d', 'Last 7 days', new Date(now - 7 * DAY)], ['28d', 'Last 28 days', new Date(now - 28 * DAY)], ['month', now.toLocaleString('en-IN', {month: 'long'}), month]].map(([key, label, start]) => {
    const from = iso(start), base = snapAt.get(c.id, from) ?? firstAfter.get(c.id, from), u = uploadsIn.get(c.id, from);
    return {key, label, from, views: base ? c.total_views - base.v : null, since: base && base.ts > from ? base.ts : null,
      uploads: u.n, shorts: u.shorts ?? 0, uploadViews: u.views ?? 0,
      long: {n: u.n - (u.shorts ?? 0), views: (u.views ?? 0) - (u.shortViews ?? 0)}, short: {n: u.shorts ?? 0, views: u.shortViews ?? 0}};
  });
}

function delta(c, hours) {
  const then = snapAt.get(c.id, iso(Date.now() - hours * HOUR));
  return then ? {s: c.subscribers - then.s, v: c.total_views - then.v, n: c.video_count - then.n, since: then.ts} : null;
}

// Views at a given age (hours) by interpolating between snapshots; publish time counts as 0 views.
function viewsAt(points, age) {
  const i = points.findIndex(p => p.age >= age);
  if (i < 1) return null;
  const a = points[i - 1], b = points[i];
  if (b.age - a.age > Math.max(6, age)) return null; // too coarse to trust
  return a.views + (b.views - a.views) * (age - a.age) / (b.age - a.age || 1);
}

function launches(pool) {
  const curves = new Map(pool.filter(v => !v.approx).map(v => {
    const t0 = new Date(v.published).getTime();
    const points = [{age: 0, views: 0}, ...launchSnaps.all(v.id, iso(t0 + 80 * HOUR)).map(s => ({age: (new Date(s.ts) - t0) / HOUR, views: s.views}))];
    return [v.id, points];
  }));
  const expected = (v, age) => median(pool.filter(p => p.id !== v.id && !!p.short === !!v.short && curves.has(p.id))
    .map(p => viewsAt(curves.get(p.id), age)).filter(x => x != null));
  return pool.filter(v => !v.approx && Date.now() - new Date(v.published) <= 72 * HOUR).map(v => {
    const age = (Date.now() - new Date(v.published)) / HOUR;
    const peers = pool.filter(p => p.id !== v.id && !!p.short === !!v.short && curves.has(p.id) && viewsAt(curves.get(p.id), age) != null).length;
    const exp = peers >= 3 ? expected(v, age) : null;
    return {
      id: v.id, title: v.title, short: !!v.short, published: v.published, thumbnail: v.thumbnail, views: v.views, age,
      expected: exp, pace: exp ? v.views / exp : null, peers,
      checkpoints: LAUNCH_AGES.filter(a => a <= age).map(a => ({age: a, views: viewsAt(curves.get(v.id), a), expected: expected(v, a)}))
    };
  });
}

function analytics(c) {
  const daily = new Map();
  for (const row of seriesQ.all(c.id, iso(Date.now() - 3650 * DAY))) daily.set(row.ts.slice(0, 10), row);
  const pool = poolQ.all(c.id), score = scorer(pool);
  const scored = pool.map(v => ({id: v.id, title: v.title, short: !!v.short, published: v.published, thumbnail: v.thumbnail, views: v.views, likes: v.likes, approx: !!v.approx, ...score(v)}));
  const recent = recentQ.all(c.id).map(v => {
    const base = videoAt.get(v.id, iso(Date.now() - DAY)) ?? videoFirst.get(v.id);
    const hours = base ? (new Date(v.updated_at) - new Date(base.ts)) / HOUR : 0;
    const gained = base && hours >= 0.5 ? v.views - base.views : null;
    return {id: v.id, title: v.title, short: !!v.short, published: v.published, thumbnail: v.thumbnail, views: v.views, likes: v.likes,
      gained, perHour: gained != null ? gained / hours : null, window: hours, ...score(v)};
  });
  return {
    id: c.id, kind: c.kind, name: c.name,
    rivalOf: c.kind === 'competitor' ? db.prepare(`SELECT own FROM rivals WHERE competitor=?`).all(c.id).map(r => r.own) : [], color: c.color, path: c.path,
    url: 'https://www.youtube.com/' + (c.handle ?? c.path),
    handle: c.handle ?? (c.path.startsWith('@') ? c.path : null),
    channelId: c.channel_id, title: c.title, avatar: c.avatar, country: c.country, joined: c.joined, description: c.description,
    subscribers: c.subscribers, totalViews: c.total_views, videoCount: c.video_count,
    updatedAt: c.updated_at, error: c.error, addedAt: c.added_at,
    periods: periods(c),
    deltas: {day2: delta(c, 48), day: delta(c, 24), week: delta(c, 24 * 7), month: delta(c, 24 * 30)},
    trackingSince: firstSnap.get(c.id)?.ts ?? null,
    history: [...daily.entries()].map(([date, r]) => ({date, s: r.s, v: r.v, n: r.n})),
    recent,
    pool: scored,
    outliers: scored.filter(v => v.outlier).sort((a, b) => b.score - a.score).slice(0, 8),
    poolSize: pool.length,
    launches: launches(pool)
  };
}

export function dashboard() {
  const channels = db.prepare(`SELECT * FROM channels ORDER BY kind DESC, position, id`).all().map(analytics);
  const last = db.prepare(`SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
  const counts = db.prepare(`SELECT (SELECT count(*) FROM channel_snapshots) channelSnapshots, (SELECT count(*) FROM video_snapshots) videoSnapshots,
    (SELECT count(*) FROM videos) videos, (SELECT count(*) FROM runs) runs`).get();
  const alerts = db.prepare(`SELECT a.* FROM alerts a LEFT JOIN channels c ON c.id=a.channel WHERE a.kind<>'upload' AND coalesce(c.kind,'own')<>'competitor' ORDER BY a.ts DESC, a.id DESC LIMIT 60`).all().map(a => ({...a, read: !!a.read}));
  const plans = db.prepare(`SELECT * FROM plans ORDER BY coalesce(date,'9999'), created_at`).all();
  return {
    channels, alerts, plans, rankings: rankingData(), dates: pendingDates(0), notifications: {...notificationSettings(), digest: digestSettings()},
    unread: db.prepare(`SELECT count(*) n FROM alerts a LEFT JOIN channels c ON c.id=a.channel WHERE a.read=0 AND a.kind<>'upload' AND coalesce(c.kind,'own')<>'competitor'`).get().n,
    status: {running: !!state.running, lastRun: last ? {...last} : null, nextRun: state.nextRun ? iso(state.nextRun) : null,
      intervalMinutes: INTERVAL / 60000, db: {...counts}}
  };
}

// ---------- HTTP ----------
const STATUSES = ['Idea', 'In production', 'Scheduled', 'Published'], FORMATS = ['Long-form', 'Short'];
function cleanPlan(p) {
  const title = String(p.title ?? '').trim().slice(0, 150);
  if (!title) throw Object.assign(new Error('A title is required.'), {status: 400});
  const channel = db.prepare(`SELECT id FROM channels WHERE id=?`).get(Number(p.channel))?.id ?? null;
  return {
    id: /^[\w-]{8,64}$/.test(p.id ?? '') ? p.id : randomUUID(), title, channel,
    format: FORMATS.includes(p.format) ? p.format : 'Long-form', status: STATUSES.includes(p.status) ? p.status : 'Idea',
    date: /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '') ? p.date : null,
    youtube_id: /^[\w-]{11}$/.test(p.youtube_id ?? p.youtubeId ?? '') ? (p.youtube_id ?? p.youtubeId) : null,
    notes: p.notes ? String(p.notes).slice(0, 1000) : null
  };
}
const savePlan = p => db.prepare(`INSERT INTO plans (id, title, channel, format, status, date, youtube_id, notes) VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title, channel=excluded.channel, format=excluded.format, status=excluded.status,
  date=excluded.date, youtube_id=excluded.youtube_id, notes=excluded.notes`).run(p.id, p.title, p.channel, p.format, p.status, p.date, p.youtube_id, p.notes);

// ---------- exact upload dates (from the Channel Studio browser extension) ----------
// YouTube's list pages only give relative dates; each video's own page has the exact one. The extension
// reads those pages in your browser and sends the dates here. A date never changes, so each video is done once.
db.exec(`CREATE TABLE IF NOT EXISTS video_dates (id TEXT PRIMARY KEY, published TEXT NOT NULL, ts TEXT NOT NULL)`);
const exactDate = db.prepare(`SELECT published FROM video_dates WHERE id=?`);
function pendingDates(limit) {
  const done = new Set(db.prepare(`SELECT id FROM video_dates`).all().map(r => r.id));
  // Your channels first, then competitors (newest estimates first), then channels opened from search.
  const ids = db.prepare(`SELECT v.id FROM videos v JOIN channels c ON c.id=v.channel WHERE v.approx=1 ORDER BY c.kind='own' DESC, v.published DESC`).all().map(r => r.id);
  for (const row of db.prepare(`SELECT data FROM lookups ORDER BY fetched_at DESC`).all())
    for (const v of JSON.parse(row.data).list ?? []) if (v.approx || !v.published) ids.push(v.id);
  const out = [...new Set(ids)].filter(id => !done.has(id));
  return {ids: out.slice(0, limit), remaining: out.length, done: done.size};
}
async function saveDates(list) {
  const ins = db.prepare(`INSERT INTO video_dates (id, published, ts) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET published=excluded.published, ts=excluded.ts`);
  const upd = db.prepare(`UPDATE videos SET published=?, approx=0 WHERE id=?`);
  const ts = iso(), min = Date.parse('2005-04-01'), max = Date.now() + DAY;
  let saved = 0;
  await batch(() => {
    for (const x of Array.isArray(list) ? list.slice(0, 500) : []) {
      const t = Date.parse(x?.published);
      if (!/^[\w-]{11}$/.test(x?.id ?? '') || !(t >= min && t <= max)) continue;
      const when = iso(t);
      ins.run(x.id, when, ts); upd.run(when, x.id); saved++;
    }
  });
  return {saved, ...pendingDates(0)};
}

// ---------- keyword search inside one channel ----------
// YouTube's in-channel search (exact views, relative ages) merged with what the dashboard knows
// (exact dates, likes, last-24h gain). Results are cached for 30 minutes per channel + keyword.
const channelSearchCache = new Map();
async function channelSearch(channelId, q) {
  const c = db.prepare(`SELECT id, path, handle FROM channels WHERE id=?`).get(channelId);
  if (!c) throw Object.assign(new Error('Unknown channel.'), {status: 404});
  const key = c.id + ':' + q.toLowerCase();
  const hit = channelSearchCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.data;
  // YouTube sometimes answers with an empty page; try once more before showing "no videos".
  let found = await searchChannelVideos(c.handle ?? c.path, q);
  if (!found.length) found = await searchChannelVideos(c.handle ?? c.path, q);
  const known = db.prepare(`SELECT published, approx, likes, views FROM videos WHERE id=?`), exact = db.prepare(`SELECT published FROM video_dates WHERE id=?`);
  const before = db.prepare(`SELECT views FROM video_snapshots WHERE video=? AND ts<=? ORDER BY ts DESC LIMIT 1`);
  // Typical views for this channel's long videos and Shorts, to score each result.
  const base = sh => median(db.prepare(`SELECT views FROM videos WHERE channel=? AND short=? AND views IS NOT NULL`).all(c.id, sh ? 1 : 0).map(r => r.views));
  const typical = {long: base(false), short: base(true)};
  const now = Date.now();
  const videos = found.map(v => {
    const k = known.get(v.id), ex = exact.get(v.id)?.published ?? (k && !k.approx ? k.published : null);
    const published = ex ?? (v.ageMs != null ? iso(now - v.ageMs) : k?.published ?? null);
    const days = published ? Math.max((now - new Date(published)) / DAY, 1 / 24) : null;
    const views = v.views ?? k?.views ?? null, b = typical[v.short ? 'short' : 'long'];
    const prev = before.get(v.id, iso(now - DAY));
    return {...v, published, exact: !!ex, views, likes: k?.likes ?? null, likeRate: k?.likes && views ? k.likes / views * 100 : null,
      perDay: views != null && days ? views / days : null, score: views != null && b ? views / b : null,
      gained24h: prev && views != null ? views - prev.views : null, tracked: !!k};
  });
  const data = {q, typical, videos, at: iso(now)};
  if (videos.length) channelSearchCache.set(key, {at: now, data});
  return data;
}

// ---------- channel lookup (searched, not tracked) ----------
// Stats for any channel opened from search. Cached; a search refreshes it only when the copy is 4+ hours old.
// Channels you track as rivals are kept current by the regular update, so they open their own page instead.
db.exec(`CREATE TABLE IF NOT EXISTS lookups (channel_id TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at TEXT NOT NULL)`);
const LOOKUP_TTL = 4 * HOUR;
async function lookupChannel(channelId) {
  const tracked = db.prepare(`SELECT id FROM channels WHERE channel_id=?`).get(channelId);
  if (tracked) return {tracked: tracked.id};
  const cached = db.prepare(`SELECT data, fetched_at FROM lookups WHERE channel_id=?`).get(channelId);
  // Copies saved before the full upload list was kept are refetched once.
  if (cached && cached.data.includes('"list":') && Date.now() - new Date(cached.fetched_at) < LOOKUP_TTL) return lookupView(JSON.parse(cached.data), cached.fetched_at, true);
  try {
    const path = 'channel/' + channelId;
    const [ch, first] = await Promise.all([loadChannel(path), loadUploads(path).catch(() => ({videos: [], shorts: []}))]);
    // The Videos tab occasionally comes back empty; try once more before saving a thin copy.
    const up = first.videos.length ? first : await loadUploads(path).catch(() => first);
    // Exact dates from the RSS feed (newest ~15); long videos otherwise use YouTube's "x weeks ago"; older Shorts have no date.
    const feed = new Map(ch.recent.map(v => [v.id, v]));
    const now = Date.now();
    const list = [...up.videos, ...up.shorts].map(v => {
      const f = feed.get(v.id);
      return {id: v.id, title: v.title ?? f?.title, short: v.short, views: v.views ?? f?.views ?? null,
        published: f?.published ?? (v.ageMs != null ? iso(now - v.ageMs) : null), approx: !f};
    });
    for (const f of ch.recent) if (!list.some(v => v.id === f.id)) list.push({id: f.id, title: f.title, short: f.short, views: f.views, published: f.published, approx: false});
    const data = {channelId, path, handle: ch.handle ?? null, title: ch.title, avatar: ch.avatar, country: ch.country, joined: ch.joined, description: ch.description,
      subscribers: ch.subscribers, totalViews: ch.totalViews, videoCount: ch.videoCount, list};
    const ts = iso(now);
    db.prepare(`INSERT INTO lookups (channel_id, data, fetched_at) VALUES (?,?,?) ON CONFLICT(channel_id) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at`).run(channelId, JSON.stringify(data), ts);
    return lookupView(data, ts, false);
  } catch (err) {
    // Offline or blocked: fall back to an older copy if there is one.
    if (cached) return {...lookupView(JSON.parse(cached.data), cached.fetched_at, true), stale: err.message};
    throw Object.assign(err, {status: 502});
  }
}
// Applies exact dates collected by the browser extension, then builds the periods and recent list.
function lookupView(data, fetchedAt, cached) {
  const list = (data.list ?? data.recent ?? []).map(v => { const d = exactDate.get(v.id); return d ? {...v, published: d.published, approx: false} : v; });
  const now = Date.now(), monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  // Shorts without any date can't be placed; periods older than the oldest dated Short may miss some.
  const undatedShorts = list.some(v => v.short && !v.published);
  const oldestShort = list.filter(v => v.short && v.published && !v.approx).map(v => v.published).sort()[0] ?? null;
  const periods = [['7d', 'Last 7 days', new Date(now - 7 * DAY)], ['28d', 'Last 28 days', new Date(now - 28 * DAY)], ['month', new Date().toLocaleString('en-IN', {month: 'long'}), monthStart]].map(([key, label, start]) => {
    const inP = list.filter(v => v.published && new Date(v.published) >= start);
    const part = sh => { const x = inP.filter(v => !!v.short === sh); return {n: x.length, views: x.reduce((t, v) => t + (v.views ?? 0), 0)}; };
    return {key, label, long: part(false), short: part(true), shortsPartial: undatedShorts && (!oldestShort || new Date(oldestShort) > start)};
  });
  const {list: _, ...rest} = data;
  return {...rest, periods, feedOldest: oldestShort, fetchedAt, cached,
    recent: list.filter(v => v.published).sort((a, b) => b.published.localeCompare(a.published)).slice(0, 24),
    approxCount: list.filter(v => v.approx || !v.published).length};
}

// ---------- routes ----------
// Each handler gets {params, query, body(), request, response, route} and returns the JSON for a 200,
// or reply(status, body). Errors with a .status (HttpError) are sent with that status.
const routes = compile([
  ['GET', '/api/dashboard', () => dashboard()],

  // Nodes. The ping is open to any origin so the Nodes page can time every node from the browser.
  ['GET', '/api/node/ping', ({response}) => { response.setHeader('Access-Control-Allow-Origin', '*'); return {id: NODE_ID, name: NODE_NAME, version: VERSION, time: iso()}; }],
  ['GET', '/api/nodes', () => nodesData()],
  ['POST', '/api/nodes/:id([\\w-]+)/mode', async ({params, body}) => { await setNodeMode(params.id, (await body()).mode); return nodesData(); }],
  ['DELETE', '/api/nodes/:id([\\w-]+)', async ({params}) => { await removeNode(params.id); return nodesData(); }],
  ['POST', '/api/nodes/:id([\\w-]+)/update', async ({params}) => ({result: await requestUpdate(params.id), ...(await nodesData())})],
  ['POST', '/api/nodes/auto-update', async ({body}) => { await setAutoUpdate((await body()).on === true); return nodesData(); }],

  ['GET', '/api/search/channels', async ({query}) => {
    const q = (query.get('q') ?? '').trim().slice(0, 100);
    if (q.length < 2) return [];
    const known = db.prepare(`SELECT id, kind, channel_id FROM channels`).all();
    return (await searchChannels(q)).map(c => ({...c, tracked: known.find(k => k.channel_id === c.channelId) ?? null}));
  }],

  // Exact upload dates from the browser extension.
  ['GET', '/api/dates/pending', ({query}) => pendingDates(Math.min(100, Number(query.get('limit')) || 25))],
  ['POST', '/api/dates', async ({body}) => saveDates((await body()).dates)],
  ['GET', '/api/dates/status', () => pendingDates(0)],

  ['GET', '/api/channels/:id(\\d+)/search', ({params, query}) => {
    const q = (query.get('q') ?? '').trim().slice(0, 100);
    if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters.');
    return channelSearch(Number(params.id), q);
  }],
  ['GET', '/api/lookup/:id(UC[\\w-]{22})', ({params}) => lookupChannel(params.id)],

  // Database, backups and the manual update.
  ['GET', '/api/db/health', () => dbHealth()],
  ['POST', '/api/db/settings', async ({body}) => { saveDbSettings(await body()); return dbHealth(); }],
  ['POST', '/api/db/action', async ({body}) => { const {action} = await body(); const result = await runAction(String(action ?? '')); return {...result, health: dbHealth()}; }],
  ['GET', '/api/backups', () => backupSettings()],
  ['POST', '/api/backups', () => backupNow()],
  ['POST', '/api/settings/backup', async ({body}) => setMirror((await body()).mirror)],
  ['POST', '/api/refresh', async () => { await runBatch('manual'); return dashboard(); }],

  // Competitors.
  // topic-research (RESEARCH.md)
  ['GET', '/api/research/ideas', async ({query}) => { try { return {...await ideasWithDb(query.get('q'), query.get('geo') ?? 'IN'), via: 'node'}; } catch (err) { throw new HttpError(err.status ?? 502, err.message); } }],
  ['GET', '/api/research/score', async ({query}) => { try { return {...await scoreWithDb(query.get('q'), query.get('geo') ?? 'IN'), via: 'node'}; } catch (err) { throw new HttpError(err.status ?? 502, err.message); } }],
  ['GET', '/api/research/compare', async ({query}) => { try { return {...await researchCompare(query.get('q'), query.get('geo') ?? 'IN'), via: 'node'}; } catch (err) { throw new HttpError(err.status ?? 502, err.message); } }],
  ['GET', '/api/research/angles', async ({query}) => { try { return {...await anglesWithDb(query.get('q'), query.get('geo') ?? 'IN'), via: 'node'}; } catch (err) { throw new HttpError(err.status ?? 502, err.message); } }],
  // POST so the browser allows the long wait (Gemini can take up to a minute)
  ['POST', '/api/research/brief', async ({body}) => { const b = await body(); try { return await researchBrief(b.q, 'IN', {lang: b.lang, fresh: !!b.fresh, coverage: onTopic(String(b.q ?? ''))}); } catch (err) { throw new HttpError(err.status ?? 502, err.message); } }],
  ['GET', '/api/research/picks', ({query}) => readPicks(query.get('channel'))],
  ['POST', '/api/research/picks', async ({body}) => { const b = await body().catch(() => ({})); try { return await makePicks(b.channel); } catch (err) { throw new HttpError(err.status ?? 502, err.message); } }],
  ['POST', '/api/research/picks/vote', async ({body}) => { try { return await votePick(await body()); } catch (err) { throw new HttpError(err.status ?? 500, err.message); } }],
  ['GET', '/api/research/profile', () => readProfile()],
  ['POST', '/api/research/profile', async ({body}) => saveProfile(await body())],
  ['GET', '/api/research/saved', () => savedIdeas()],
  ['POST', '/api/research/saved', async ({body}) => { try { return await saveIdea(await body()); } catch (err) { throw new HttpError(err.status ?? 500, err.message); } }],
  ['POST', '/api/research/saved/remove', async ({body}) => { const b = await body(); return removeIdea(String(b.q ?? ''), String(b.geo ?? 'IN')); }],
  // Google Trends (also answered by api/trends.js on Vercel when no node can).
  ['GET', '/api/trends/explore', async ({query}) => { try { return {...await trendsExplore({q: query.get('q'), geo: query.get('geo') ?? 'IN', prop: query.get('prop'), time: query.get('time')}), via: 'node'}; } catch (err) { throw new HttpError(err.status ?? 502, err.message); } }],
  ['GET', '/api/trends/trending', async ({query}) => { try { return {...await trendsTrending({geo: query.get('geo')}), via: 'node'}; } catch (err) { throw new HttpError(err.status ?? 502, err.message); } }],
  ['GET', '/api/thumbs/creators', () => thumbCreators()],
  ['GET', '/api/thumbs/prefs', () => thumbPrefs()],
  ['POST', '/api/thumbs/prefs', async ({body}) => saveThumbPrefs(await body())],   // POST: nodes before this version only allow GET/POST/DELETE across sites
  ['POST', '/api/thumbs/creators', async ({body}) => addThumbCreator((await body()).input)],
  ['DELETE', '/api/thumbs/creators/:id(UC[\\w-]{22})', ({params}) => removeThumbCreator(params.id)],
  ['POST', '/api/competitors', async ({body}) => {
    const {input, own} = await body();
    const owner = db.prepare(`SELECT id, name FROM channels WHERE id=? AND kind='own'`).get(Number(own));
    if (!owner) throw new HttpError(400, 'Choose which of your channels this competitor is for.');
    const path = typeof input === 'string' ? channelPath(input.slice(0, 300)) : null;
    if (!path) throw new HttpError(400, 'Enter a channel handle like @mkbhd or a YouTube channel link.');
    const data = await loadChannel(path).catch(err => { throw Object.assign(err, {status: 404}); });
    const exists = db.prepare(`SELECT id, kind, name FROM channels WHERE path=? OR (channel_id IS NOT NULL AND channel_id=?)`).get(data.handle ?? path, data.channelId ?? '');
    if (exists?.kind === 'own') throw new HttpError(409, 'That is one of your channels: ' + exists.name + '.');
    if (exists) {
      // Already tracked for another of your channels: just link it here, keeping its history.
      if (db.prepare(`SELECT 1 FROM rivals WHERE own=? AND competitor=?`).get(owner.id, exists.id)) throw new HttpError(409, exists.name + ' is already a competitor of ' + owner.name + '.');
      db.prepare(`INSERT INTO rivals (own, competitor) VALUES (?,?)`).run(owner.id, exists.id);
      return reply(201, dashboard());
    }
    const {lastInsertRowid: id} = db.prepare(`INSERT INTO channels (path, kind, name, color, position) VALUES (?, 'competitor', ?, ?, (SELECT coalesce(max(position),0)+1 FROM channels WHERE kind='competitor'))`)
      .run(data.handle ?? path, data.title || path, nextCompetitorColor());
    db.prepare(`INSERT INTO rivals (own, competitor) VALUES (?,?)`).run(owner.id, id);
    await store({id}, data);
    await loadUploads(data.handle ?? path).then(u => backfill({id}, u)).catch(() => {});
    return reply(201, dashboard());
  }],
  ['DELETE', '/api/competitors/:id(\\d+)', ({params, query}) => {
    // With ?own=, unlink from that channel only; the competitor (and its history) is deleted once nothing links to it.
    const id = Number(params.id), own = query.get('own');
    tx(() => {
      if (own) db.prepare(`DELETE FROM rivals WHERE own=? AND competitor=?`).run(Number(own), id);
      if (!own || !db.prepare(`SELECT 1 FROM rivals WHERE competitor=?`).get(id)) db.prepare(`DELETE FROM channels WHERE id=? AND kind='competitor'`).run(id);
    });
    return dashboard();
  }],

  // Rankings has its own sub-routes (server/rankings.js).
  ['*', '/api/rankings/:rest(.+)', async ({route, body}) => {
    const out = await rankingRoutes(route, body, alert);
    if (!out) throw new HttpError(404, 'Unknown API route.');
    return out.json ?? dashboard();
  }],

  // Notifications and alerts.
  ['POST', '/api/settings/digest', async ({body}) => { saveDigest(await body()); return dashboard(); }],
  ['POST', '/api/settings/digest/send', async () => { const d = digestSettings(); await broadcast(digest(d.mode === 'weekly' ? 7 : 1)); return dashboard(); }],
  ['POST', '/api/settings/:hook(discord|slack)', async ({params, body}) => { saveNotification(params.hook, await body()); return dashboard(); }],
  ['POST', '/api/settings/:hook(discord|slack)/test', async ({params}) => { await sendTest(params.hook); return dashboard(); }],
  ['POST', '/api/alerts/read', () => { db.exec(`UPDATE alerts SET read=1 WHERE read=0`); return dashboard(); }],

  // Planner.
  ['POST', '/api/plans', async ({body}) => { savePlan(cleanPlan(await body())); return dashboard(); }],
  ['POST', '/api/plans/import', async ({body}) => {
    // One-time move of the old browser-stored planner (channel was an index into the three own channels).
    const {videos} = await body();
    if (db.prepare(`SELECT count(*) n FROM plans`).get().n) return dashboard();
    const own = db.prepare(`SELECT id FROM channels WHERE kind='own' ORDER BY position`).all().map(r => r.id);
    tx(() => (Array.isArray(videos) ? videos : []).slice(0, 500).forEach(v => { try { savePlan(cleanPlan({...v, channel: own[v?.channel] ?? own[0]})); } catch {} }));
    return dashboard();
  }],
  ['DELETE', '/api/plans/:id([\\w-]+)', ({params}) => { db.prepare(`DELETE FROM plans WHERE id=?`).run(params.id); return dashboard(); }],

  ['GET', '/api/channels/:id(\\d+)/outliers', ({params, query}) => windowOutliers(Number(params.id), query.get('from'))],
  // Videos: views over time (from the snapshots) plus what's stored, and details for any public video.
  ['GET', '/api/videos/:id([\\w-]{11})/history', ({params}) => {
    const v = db.prepare(`SELECT v.id, v.title, v.short, v.published, v.approx, v.views, v.likes, c.name channel FROM videos v JOIN channels c ON c.id=v.channel WHERE v.id=?`).get(params.id);
    const exact = db.prepare(`SELECT published FROM video_dates WHERE id=?`).get(params.id)?.published;
    const points = db.prepare(`SELECT ts, views FROM video_snapshots WHERE video=? ORDER BY ts`).all(params.id);
    return {video: v ? {...v, published: exact ?? v.published, exact: !!exact || v.approx === 0} : null, points};
  }],
  ['GET', '/api/video', async ({query}) => {
    const id = query.get('id');
    if (!/^[A-Za-z0-9_-]{11}$/.test(id ?? '')) throw new HttpError(400, 'Enter a valid YouTube video ID or link.');
    try {
      const {videoDetails: d} = await yt.getInfo('https://www.youtube.com/watch?v=' + id);
      return {id, title: d.title, channel: d.author?.name, views: d.viewCount, seconds: d.lengthSeconds, published: d.publishDate?.slice(0, 10), thumbnail: d.thumbnails?.at(-1)?.url};
    } catch { throw new HttpError(502, 'YouTube video details could not be retrieved. Check that the video is public and try again.'); }
  }]
]);

export function apiMiddleware() {
  return async (request, response, next) => {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    // JSON responses are gzip-compressed when the browser accepts it (the dashboard payload shrinks ~10×).
    const send = (status, body) => {
      const json = JSON.stringify(body), headers = {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding'};
      if (json.length > 2048 && /\bgzip\b/.test(request.headers['accept-encoding'] ?? '')) {
        response.writeHead(status, {...headers, 'Content-Encoding': 'gzip'});
        return response.end(gzipSync(json, {level: 6}));
      }
      response.writeHead(status, headers);
      response.end(json);
    };
    const route = request.method + ' ' + url.pathname;
    // Other sites (the Vercel page, the browser extension) may call the API; what they can do is decided by the pass check below.
    const origin = request.headers.origin;
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600'});
        return response.end();
      }
    }
    // From this PC or the home network: open, as before. From the internet (a tunnel): only with a signed pass.
    if (route !== 'GET /api/node/ping' && !isLocal(request)) {
      if (!process.env.AUTH_SECRET) return send(403, {error: 'This node is not set up for internet access (AUTH_SECRET is missing in its .env).'});
      if (!checkToken(bearer(request), process.env.AUTH_SECRET)) return send(401, {error: 'Please sign in again.', auth: true});
    }
    const found = match(routes, request.method, url.pathname);
    if (!found) return send(404, {error: 'Unknown API route.'});
    if (found.status) return send(found.status, {error: 'That method is not allowed here.'});
    try {
      const out = await found.handler({params: found.params, query: url.searchParams, body: () => readJson(request), request, response, route});
      return out?.[REPLY] ? send(out.status, out.body) : send(200, out ?? null);
    } catch (err) {
      return send(err.status ?? 500, {error: err.message || 'Something went wrong.'});
    }
  };
}
