// Database health: a report on the SQLite file, maintenance actions, and data-retention settings.
// Settings live in the `settings` table under "db.*". Maintenance runs on its own once a day.
import {existsSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {db, dbPath, backupDir, cloud, sync, writes, ping, syncNow, SYNC_SECONDS} from './db.js';

const DAY = 864e5;
const iso = (t = Date.now()) => new Date(t).toISOString();
const read = (k, d) => { const r = db.prepare(`SELECT value FROM settings WHERE key=?`).get(k); return r ? JSON.parse(r.value) : d; };
const write = (k, v) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, JSON.stringify(v));

// ---------- settings ----------
export const DEFAULTS = {
  backupKeepDays: 14,      // daily backups kept
  backupEveryHours: 24,    // how often a backup is made
  rankResultsDays: 180,    // search-ranking checks older than this are deleted (0 = keep forever)
  thinSnapshotsDays: 60,   // video view snapshots older than this are thinned to one per day (0 = never)
  alertsDays: 120,         // read alerts older than this are deleted (0 = keep forever)
  incidentsDays: 90,       // resolved ranking incidents older than this are deleted (0 = keep forever)
  autoMaintenance: true,   // daily cleanup + WAL checkpoint, weekly optimize, compact when 20%+ is free space
  integrityOnStart: true   // quick check when the server starts (damaged files are restored from backup)
};
const LIMITS = {backupKeepDays: [3, 90], backupEveryHours: [6, 168], rankResultsDays: [0, 3650], thinSnapshotsDays: [0, 3650], alertsDays: [0, 3650], incidentsDays: [0, 3650]};
export const dbSettings = () => ({...DEFAULTS, ...read('db.settings', {})});
export function saveDbSettings(body) {
  const next = {...dbSettings()};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (!(k in DEFAULTS)) continue;
    if (typeof DEFAULTS[k] === 'boolean') next[k] = !!v;
    else { const n = Math.round(Number(v)); if (!Number.isFinite(n)) continue; const [lo, hi] = LIMITS[k]; next[k] = n === 0 && lo === 0 ? 0 : Math.min(hi, Math.max(lo || 1, n)); }
  }
  write('db.settings', next);
  return next;
}

// ---------- report ----------
const size = f => existsSync(f) ? statSync(f).size : 0;
const TABLES = {
  channel_snapshots: {label: 'Channel snapshots', ts: 'ts'}, video_snapshots: {label: 'Video view snapshots', ts: 'ts'},
  videos: {label: 'Videos', ts: 'published'}, rank_results: {label: 'Ranking checks', ts: 'ts'}, rank_incidents: {label: 'Ranking incidents', ts: 'opened'},
  alerts: {label: 'Alerts', ts: 'ts'}, runs: {label: 'Update runs', ts: 'started_at'}, rank_queries: {label: 'Searches'}, channels: {label: 'Channels'},
  lookups: {label: 'Searched channels (cache)', ts: 'fetched_at'}, video_dates: {label: 'Exact upload dates', ts: 'ts'}, plans: {label: 'Planner items'}
};
// ---------- cloud (Turso) ----------
const REGIONS = {'aws-ap-south-1': 'Mumbai', 'aws-ap-northeast-1': 'Tokyo', 'aws-eu-west-1': 'Ireland', 'aws-us-east-1': 'Virginia', 'aws-us-east-2': 'Ohio', 'aws-us-west-2': 'Oregon'};
// Free plan limits (per month). Shown as a guide; the account's real plan comes from Turso when an API token is set.
export const FREE = {rowsRead: 500e6, rowsWritten: 10e6, storage: 5e9};
const usage = {data: null, at: 0, error: '', pending: null};
// Optional: TURSO_API_TOKEN in .env (Turso dashboard > Settings > API tokens) lets the page show real monthly usage.
function loadUsage(force = false) {
  if (!cloud || !process.env.TURSO_API_TOKEN) return Promise.resolve();
  if (usage.pending) return usage.pending;
  if (!force && Date.now() - usage.at < 10 * 60e3) return Promise.resolve();
  return usage.pending = fetchUsage().finally(() => { usage.pending = null; });
}
async function fetchUsage() {
  const token = process.env.TURSO_API_TOKEN;
  const get = async path => {
    const r = await fetch('https://api.turso.tech' + path, {headers: {Authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(15e3)});
    if (!r.ok) throw new Error(`Turso API ${r.status} on ${path.split('/').slice(0, 4).join('/')}`);
    return r.json();
  };
  try {
    const host = hostOf(process.env.DATABASE_URL);
    let org = process.env.TURSO_ORG, dbName = null, info = null;
    const orgs = org ? [org] : ((await get('/v1/organizations')).map?.(o => o.slug) ?? []);
    for (const o of orgs) {
      const list = (await get(`/v1/organizations/${o}/databases`)).databases ?? [];
      info = list.find(d => d.Hostname === host || host.startsWith((d.Name ?? '') + '-'));
      if (info) { org = o; dbName = info.Name; break; }
    }
    if (!info) throw new Error('This database was not found with the API token. Is the token from the same Turso account?');
    const u = (await get(`/v1/organizations/${org}/databases/${dbName}/usage`)).database?.usage ?? {};
    let plan = null; try { plan = (await get(`/v1/organizations/${org}/subscription`)).subscription ?? null; } catch {}
    const planId = typeof plan === 'string' ? plan : plan?.plan ?? plan?.name ?? null;
    usage.data = {org, name: dbName, group: info.group ?? null, regions: info.regions ?? [], plan: planId === 'starter' ? 'Free' : planId,
      resets: plan?.current_billing_period_end ?? null,
      rowsRead: u.rows_read ?? null, rowsWritten: u.rows_written ?? null, storage: u.storage_bytes ?? null, synced: u.bytes_synced ?? null};
    usage.error = '';
  } catch (err) { usage.error = err.message; }
  usage.at = Date.now();
}
function cloudInfo() {
  loadUsage();
  const host = hostOf(process.env.DATABASE_URL), region = /\.([a-z]+-[a-z]+-[a-z]+-\d)\.turso\.io$/.exec(host)?.[1] ?? null;
  return {kind: 'cloud', host, region, regionName: REGIONS[region] ?? region, syncedAt: sync.at, syncMs: sync.ms, syncError: sync.error, every: SYNC_SECONDS, since: sync.since,
    writes: {...writes}, replica: size(dbPath) + size(dbPath + '-wal'),
    usage: process.env.TURSO_API_TOKEN ? {...usage.data, error: usage.error, checkedAt: usage.at ? iso(usage.at) : null} : null, free: FREE};
}

const hostOf = u => { try { return new URL(u.replace(/^libsql:/, 'https:')).host; } catch { return ''; } };
const cols = t => new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name));

// Periods with no channel update for 3+ hours (the PC or server was off), last 30 days.
function gaps() {
  const own = db.prepare(`SELECT id FROM channels WHERE kind='own' ORDER BY position LIMIT 1`).get();
  if (!own) return [];
  const ts = db.prepare(`SELECT ts FROM channel_snapshots WHERE channel=? AND ts>=? ORDER BY ts`).all(own.id, iso(Date.now() - 30 * DAY)).map(r => Date.parse(r.ts));
  ts.push(Date.now());
  const out = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > 3 * 3600e3) out.push({from: iso(ts[i - 1]), to: iso(ts[i]), hours: Math.round((ts[i] - ts[i - 1]) / 3600e3)});
  return out.reverse();
}

export function dbHealth() {
  const p = k => Object.values(db.prepare(`PRAGMA ${k}`).get() ?? {})[0];
  const pages = p('page_count'), free = p('freelist_count'), pageSize = p('page_size');
  const tables = Object.entries(TABLES).filter(([t]) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)).map(([t, m]) => {
    const c = cols(t), hasTs = m.ts && c.has(m.ts);
    const row = db.prepare(`SELECT count(*) n${hasTs ? `, min(${m.ts}) oldest, max(${m.ts}) newest, sum(${m.ts}>=?) week` : ''} FROM "${t}"`).get(...(hasTs ? [iso(Date.now() - 7 * DAY)] : []));
    return {table: t, label: m.label, rows: row.n, oldest: row.oldest ?? null, newest: row.newest ?? null, week: row.week ?? null};
  });
  const backups = existsSync(backupDir) ? readdirSync(backupDir).filter(f => f.endsWith('.db')) : [];
  const g = gaps();
  const integrity = read('db.integrity', null), lastBackup = read('backup.last', null);
  // Overall status: what needs attention, most serious first.
  const issues = [];
  if (integrity && integrity.result !== 'ok') issues.push({level: 'bad', text: 'Last integrity check found problems. Restore a backup or run a full check.'});
  if (!lastBackup || Date.now() - Date.parse(lastBackup) > 2 * dbSettings().backupEveryHours * 3600e3) issues.push({level: 'warn', text: lastBackup ? 'No recent backup.' : 'No backup yet.'});
  if (cloud && writes.error) issues.push({level: 'warn', text: 'A batch of writes to the cloud database is retrying: ' + writes.error});
  if (cloud && sync.error) issues.push({level: 'bad', text: 'Cannot reach the cloud database: ' + sync.error});
  if (!cloud && pages && free / pages > 0.2) issues.push({level: 'warn', text: `${Math.round(free / pages * 100)}% of the file is unused space. Compact to shrink it.`});
  if (!cloud && size(dbPath + '-wal') > 64e6) issues.push({level: 'warn', text: 'The write-ahead log is large. Run a checkpoint.'});
  const recentGap = g.find(x => Date.now() - Date.parse(x.to) < 2 * DAY);
  if (recentGap) issues.push({level: 'info', text: `No updates for ${recentGap.hours} hours recently (PC or server off). Numbers for that period are estimates.`});
  return {
    status: issues.some(i => i.level === 'bad') ? 'bad' : issues.some(i => i.level === 'warn') ? 'warn' : 'good', issues,
    file: {path: dbPath, size: size(dbPath), wal: size(dbPath + '-wal'), pages, pageSize, free, freePct: pages ? +(free / pages * 100).toFixed(1) : 0,
      journal: p('journal_mode'), sqlite: db.prepare('SELECT sqlite_version() v').get().v},
    backups: {count: backups.length, size: backups.reduce((t, f) => t + size(join(backupDir, f)), 0), last: lastBackup, dir: backupDir},
    mode: cloud ? cloudInfo() : {kind: 'local'},
    integrity, maintenance: read('db.maintenance', {}), settings: dbSettings(), tables, gaps: g.slice(0, 10)
  };
}

// ---------- actions ----------
const mark = (k, extra = {}) => { const m = read('db.maintenance', {}); m[k] = {at: iso(), ...extra}; write('db.maintenance', m); };
export async function runAction(action) {
  if (action === 'ping') { const r = await ping(); return r ? {ok: true, message: `Round trip ${r.roundTrip} ms, sync ${r.sync} ms.`} : {ok: false, message: 'Not using a cloud database.'}; }
  if (action === 'sync') { const ms = syncNow(); return ms == null ? {ok: false, message: 'Not using a cloud database.'} : {ok: true, message: `Up to date (${ms} ms).`}; }
  if (action === 'usage') { await loadUsage(true); return usage.error ? {ok: false, message: usage.error} : {ok: true, message: 'Usage refreshed.'}; }
  return act(action);
}
function act(action) {
  const t0 = Date.now();
  if (cloud && ['optimize', 'checkpoint', 'vacuum'].includes(action)) return {ok: true, message: 'The cloud database looks after this itself.'};
  switch (action) {
    case 'quick-check':
    case 'integrity-check': {
      const rows = db.prepare(`PRAGMA ${action === 'quick-check' ? 'quick_check' : 'integrity_check'}`).all().map(r => Object.values(r)[0]);
      const result = rows.length === 1 && rows[0] === 'ok' ? 'ok' : rows.slice(0, 10).join('; ');
      write('db.integrity', {result, kind: action === 'quick-check' ? 'quick' : 'full', at: iso(), ms: Date.now() - t0});
      return {ok: result === 'ok', message: result === 'ok' ? 'No problems found.' : 'Problems found: ' + result};
    }
    case 'optimize': db.exec('ANALYZE; PRAGMA optimize;'); mark('optimize'); return {ok: true, message: 'Query statistics refreshed.'};
    case 'checkpoint': { const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); mark('checkpoint'); return {ok: !r?.busy, message: r?.busy ? 'The log is busy; try again in a moment.' : 'Write-ahead log merged into the database.'}; }
    case 'vacuum': {
      const before = size(dbPath);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
      const saved = before - size(dbPath); mark('vacuum', {saved});
      return {ok: true, message: saved > 0 ? `Compacted. Freed ${(saved / 1e6).toFixed(1)} MB.` : 'Compacted. The file was already tight.'};
    }
    case 'cleanup': { const r = cleanup(); return {ok: true, message: r.total ? `Removed ${r.total.toLocaleString('en-IN')} old rows (${Object.entries(r.removed).filter(([, n]) => n).map(([k, n]) => n + ' ' + k).join(', ')}).` : 'Nothing old enough to remove.'}; }
    default: throw Object.assign(new Error('Unknown action.'), {status: 400});
  }
}

// Applies the retention settings. Never touches your channels, videos, searches or planner items.
export function cleanup() {
  const s = dbSettings(), cut = d => iso(Date.now() - d * DAY), removed = {};
  db.exec('BEGIN');
  try {
    if (s.rankResultsDays) removed['ranking checks'] = Number(db.prepare(`DELETE FROM rank_results WHERE ts<?`).run(cut(s.rankResultsDays)).changes);
    if (s.alertsDays) removed['alerts'] = Number(db.prepare(`DELETE FROM alerts WHERE read=1 AND ts<?`).run(cut(s.alertsDays)).changes);
    if (s.incidentsDays) removed['incidents'] = Number(db.prepare(`DELETE FROM rank_incidents WHERE state='resolved' AND resolved<?`).run(cut(s.incidentsDays)).changes);
    // Thin: keep the last snapshot of each day for each video.
    if (s.thinSnapshotsDays) removed['view snapshots'] = Number(db.prepare(`DELETE FROM video_snapshots WHERE ts<? AND rowid NOT IN
      (SELECT max(rowid) FROM video_snapshots WHERE ts<? GROUP BY video, substr(ts,1,10))`).run(cut(s.thinSnapshotsDays), cut(s.thinSnapshotsDays)).changes);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  mark('cleanup', {removed: total});
  return {removed, total};
}

// ---------- automatic maintenance ----------
let timer = null, first = null;
function daily() {
  const s = dbSettings(), m = read('db.maintenance', {}), age = k => m[k] ? Date.now() - Date.parse(m[k].at) : Infinity;
  if (!s.autoMaintenance) return;
  try {
    if (age('cleanup') > 20 * 3600e3) cleanup();
    if (age('checkpoint') > 20 * 3600e3) act('checkpoint');
    if (age('optimize') > 7 * DAY) act('optimize');
    if (age('quick-check-auto') > 7 * DAY) { act('quick-check'); mark('quick-check-auto'); }
    if (cloud) return;
    const pages = Object.values(db.prepare('PRAGMA page_count').get())[0], free = Object.values(db.prepare('PRAGMA freelist_count').get())[0];
    if (pages && free / pages > 0.2 && age('vacuum') > 7 * DAY) act('vacuum');
  } catch (err) { console.error('[dashboard] maintenance failed:', err.message); }
}
export function startMaintenance() {
  stopMaintenance();
  if (dbSettings().integrityOnStart) { try { act('quick-check'); } catch {} }
  first = setTimeout(daily, 60e3);
  timer = setInterval(daily, 3600e3);
}
export function stopMaintenance() { clearTimeout(first); clearInterval(timer); timer = first = null; }
