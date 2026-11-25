// SQLite storage for channels, hourly snapshots and per-video view history.
// Two modes, picked by .env:
// - local (default): Node's built-in node:sqlite, file data/dashboard.db.
// - cloud (DATABASE_URL set): a Turso database shared by every node. This node keeps a local
//   copy (data/replica.db) for fast reads; writes go straight to Turso, so all nodes agree.
import {DatabaseSync} from 'node:sqlite';
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) { try { process.loadEnvFile(join(root, '.env')); } catch (err) { console.error('[dashboard] could not read .env:', err.message); } }
const dataDir = join(root, 'data');
mkdirSync(dataDir, {recursive: true});
export const cloud = !!process.env.DATABASE_URL;
// One "main" server process per PC holds data/server.lock. It keeps this PC's node identity and, in cloud
// mode, the local copy data/replica.db. Any other process on the same PC (a dev server, a second node) is a
// separate temporary node with its own temporary copy, deleted when it exits; two processes must never sync
// into one copy.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lockFile = join(dataDir, 'server.lock');
export const primary = (() => {
  let holder = 0;
  try { holder = Number(readFileSync(lockFile, 'utf8')) || 0; } catch {}
  if (holder && holder !== process.pid && alive(holder)) return false;
  writeFileSync(lockFile, String(process.pid));
  process.on('exit', () => { try { if (Number(readFileSync(lockFile, 'utf8')) === process.pid) rmSync(lockFile, {force: true}); } catch {} });
  return true;
})();
function replicaPath() {
  for (const f of readdirSync(dataDir)) { // temporary copies left by processes that crashed
    const m = /^replica-(\d+)\.db/.exec(f);
    if (m && !alive(Number(m[1]))) try { rmSync(join(dataDir, f), {force: true}); } catch {}
  }
  if (primary) return join(dataDir, 'replica.db');
  const tmp = join(dataDir, `replica-${process.pid}.db`);
  process.on('exit', () => { for (const ext of ['', '-wal', '-shm', '-info', '-client_wal_index']) try { rmSync(tmp + ext, {force: true}); } catch {} });
  return tmp;
}
export const dbPath = cloud ? replicaPath() : join(dataDir, 'dashboard.db');
export const SYNC_SECONDS = Math.max(5, Number(process.env.DATABASE_SYNC_SECONDS) || 15);
let collecting = null, remote = null; // see batch()
export const writes = {batches: 0, rows: 0, failed: 0, lastMs: 0, error: '', direct: 0, directMs: 0};

export const backupDir = join(dataDir, 'backups');

// Open the database; if it is damaged, set it aside and restore the newest good backup automatically.
function openChecked() {
  if (existsSync(dbPath)) {
    let probe;
    try {
      probe = new DatabaseSync(dbPath);
      const ok = probe.prepare('PRAGMA quick_check').get()?.quick_check === 'ok';
      probe.close(); probe = null;
      if (ok) return new DatabaseSync(dbPath);
      throw new Error('integrity check failed');
    } catch (err) {
      try { probe?.close(); } catch {}
      const backups = existsSync(backupDir) ? readdirSync(backupDir).filter(f => /^dashboard-.*\.db$/.test(f)).sort().reverse() : [];
      const aside = dbPath.replace(/\.db$/, `.damaged-${Date.now()}.db`);
      console.error(`[dashboard] database problem (${err.message}). Moving it to ${aside}.`);
      renameSync(dbPath, aside);
      for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) renameSync(dbPath + ext, aside + ext);
      if (backups[0]) { copyFileSync(join(backupDir, backups[0]), dbPath); console.error(`[dashboard] restored backup ${backups[0]}.`); }
    }
  }
  return new DatabaseSync(dbPath);
}
// The Turso client has the same calls as node:sqlite with small differences, smoothed over here.
function openCloud() {
  const Database = createRequire(import.meta.url)('libsql');
  const raw = new Database(dbPath, {syncUrl: process.env.DATABASE_URL, authToken: process.env.DATABASE_TOKEN || undefined});
  const t0 = Date.now();
  raw.sync();
  console.log(`[dashboard] cloud database ready (first sync ${Date.now() - t0} ms).`);
  const args = a => a.map(v => v === undefined ? null : typeof v === 'boolean' ? +v : v);
  const clean = r => { if (r && typeof r === 'object') delete r._metadata; return r; };
  return {
    raw,
    exec: sql => { const t0 = Date.now(); raw.exec(sql); const ms = Date.now() - t0; if (process.env.DB_TRACE && ms > 30) console.log(`[db] ${ms} ms  exec ${sql.replace(/\s+/g, ' ').slice(0, 80)}`); },
    prepare(sql) {
      const st = raw.prepare(sql);
      return {
        get: (...a) => clean(st.get(args(a))),
        all: (...a) => st.all(args(a)).map(clean),
        run: (...a) => {
          if (collecting) { collecting.push({sql, args: args(a)}); return {changes: 1, lastInsertRowid: null}; }
          const t0 = Date.now(), r = st.run(args(a)), ms = Date.now() - t0;
          writes.direct++; writes.directMs += ms;
          if (process.env.DB_TRACE && ms > 30) console.log(`[db] ${ms} ms  ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
          return {changes: r.changes, lastInsertRowid: r.lastInsertRowid};
        }
      };
    },
    sync: () => raw.sync(),
    close: () => raw.close()
  };
}

export const db = cloud ? openCloud() : openChecked();
if (!cloud) db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;`);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,          -- "@handle" or "channel/UC…"
    kind TEXT NOT NULL CHECK (kind IN ('own','competitor')),
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    channel_id TEXT, handle TEXT, title TEXT, avatar TEXT, country TEXT, joined TEXT, description TEXT,
    subscribers INTEGER, total_views INTEGER, video_count INTEGER,
    updated_at TEXT, error TEXT,
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS channel_snapshots (
    channel INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    subscribers INTEGER, total_views INTEGER, video_count INTEGER
  );
  CREATE INDEX IF NOT EXISTS channel_snapshots_by_time ON channel_snapshots(channel, ts);
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    channel INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title TEXT, short INTEGER, published TEXT, thumbnail TEXT,
    views INTEGER, likes INTEGER, updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS videos_by_channel ON videos(channel, published);
  CREATE TABLE IF NOT EXISTS video_snapshots (
    video TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    ts TEXT NOT NULL, views INTEGER, likes INTEGER
  );
  CREATE INDEX IF NOT EXISTS video_snapshots_by_time ON video_snapshots(video, ts);
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    trigger TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    ok INTEGER DEFAULT 0, failed INTEGER DEFAULT 0
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL, kind TEXT NOT NULL,            -- outlier | upload | milestone | published
    channel INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    video TEXT, title TEXT NOT NULL, body TEXT, read INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS alerts_by_time ON alerts(ts);
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL, channel INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    format TEXT NOT NULL DEFAULT 'Long-form', status TEXT NOT NULL DEFAULT 'Idea', date TEXT, youtube_id TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);
// Which of your channels each competitor is tracked against (a competitor can belong to several).
db.exec(`CREATE TABLE IF NOT EXISTS rivals (
  own INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  competitor INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (own, competitor)
)`);
// Columns added after the first release.
for (const sql of [
  `ALTER TABLE videos ADD COLUMN approx INTEGER NOT NULL DEFAULT 0`,   // 1 = date/views estimated from channel pages
  `ALTER TABLE channels ADD COLUMN backfilled_at TEXT`
]) { try { db.exec(sql); } catch {} }

export const OWN = [
  {path: '@techum', name: 'Techum', color: '#ff5c57'},
  {path: '@10tech_official', name: '10 Tech', color: '#4c9dff'},
  {path: '@tentechhome', name: 'Ten Tech Home', color: '#3ccf8e'}
];
const insertOwn = db.prepare(`INSERT OR IGNORE INTO channels (path, kind, name, color, position) VALUES (?, 'own', ?, ?, ?)`);
OWN.forEach((c, i) => insertOwn.run(c.path, c.name, c.color, i));
// Competitors added before per-channel tracking existed: attach them to the first channel.
db.exec(`INSERT OR IGNORE INTO rivals (own, competitor)
  SELECT (SELECT id FROM channels WHERE kind='own' ORDER BY position LIMIT 1), id FROM channels
  WHERE kind='competitor' AND id NOT IN (SELECT competitor FROM rivals)`);

const PALETTE = ['#b57bff', '#ffb340', '#2ec4d6', '#ff7ab6', '#9ccc65', '#8892ff', '#f2994a', '#56ccf2'];
export function nextCompetitorColor() {
  const used = new Set(db.prepare(`SELECT color FROM channels WHERE kind = 'competitor'`).all().map(r => r.color));
  return PALETTE.find(c => !used.has(c)) ?? PALETTE[used.size % PALETTE.length];
}

// Cloud mode: pull other nodes' writes every few seconds (reads are served from the local copy).
export const sync = {at: cloud ? new Date().toISOString() : null, error: '', ms: 0, since: new Date().toISOString()};
let syncTimer = null;
export function startSync() {
  if (!cloud || syncTimer) return;
  syncTimer = setInterval(() => {
    const t0 = Date.now();
    try { db.sync(); sync.at = new Date().toISOString(); sync.error = ''; sync.ms = Date.now() - t0; }
    catch (err) { sync.error = err.message; }
  }, SYNC_SECONDS * 1000);
  syncTimer.unref?.();
}
export function stopSync() { clearInterval(syncTimer); syncTimer = null; }

// Busy write paths (hourly updates, ranking checks) use batch(): in cloud mode their writes are collected
// and sent to Turso in one request (~0.4 s for 100 rows instead of ~10 s one by one, without freezing the
// server), then the local copy is refreshed. Await it before reading the rows back.
// Code inside batch() must not need lastInsertRowid or read back its own writes. Locally it is a plain transaction.
export async function batch(fn) {
  if (!cloud) return tx(fn);
  if (collecting) return fn();
  collecting = [];
  let result, stmts;
  try { result = fn(); } finally { stmts = collecting; collecting = null; }
  if (!stmts.length) return result;
  const t0 = Date.now();
  await remoteClient();
  for (let attempt = 1; ; attempt++) {
    try { await remote.batch(stmts, 'write'); break; }
    catch (err) {
      writes.error = err.message;
      if (attempt === 3) { writes.failed += stmts.length; throw err; }
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  writes.batches++; writes.rows += stmts.length; writes.lastMs = Date.now() - t0; writes.error = '';
  const ts = Date.now();
  try { db.sync(); sync.at = new Date().toISOString(); } catch {}
  if (process.env.DB_TRACE) console.log(`[db] batch ${stmts.length} rows ${writes.lastMs} ms, sync ${Date.now() - ts} ms`);
  return result;
}

async function remoteClient() {
  return remote ??= (await import('@libsql/client')).createClient({url: process.env.DATABASE_URL, authToken: process.env.DATABASE_TOKEN || undefined});
}
// Straight to the shared database without blocking the server (heartbeats, leases, the Nodes page).
// Locally they run on the file like any other statement.
export async function remoteRun(sql, args = []) {
  if (!cloud) return {changes: Number(db.prepare(sql).run(...args).changes)};
  const r = await (await remoteClient()).execute({sql, args});
  return {changes: r.rowsAffected};
}
export async function remoteAll(sql, args = []) {
  if (!cloud) return db.prepare(sql).all(...args);
  const r = await (await remoteClient()).execute({sql, args});
  return r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

// Round trip to the cloud database and a fresh pull of other nodes' changes (Database page "Test connection").
export async function ping() {
  if (!cloud) return null;
  await remoteClient();
  const t0 = Date.now();
  await remote.execute('SELECT 1');
  const roundTrip = Date.now() - t0, t1 = Date.now();
  db.sync(); sync.at = new Date().toISOString(); sync.error = ''; sync.ms = Date.now() - t1;
  return {roundTrip, sync: sync.ms};
}
export function syncNow() {
  if (!cloud) return null;
  const t0 = Date.now();
  db.sync(); sync.at = new Date().toISOString(); sync.error = ''; sync.ms = Date.now() - t0;
  return sync.ms;
}

export const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
