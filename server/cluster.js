// Nodes: every server running against the shared database is a node.
// - Each node has a stable id (data/node.json), a name (NODE_NAME or the PC name) and an address.
// - It sends a heartbeat to the shared `nodes` table every 15 s with its health and what it is doing.
// - Work is shared through leases: a row per job saying which node holds it until when. A lease is taken
//   with one atomic statement on the shared database, so two nodes can never hold the same job. If a node
//   dies its leases simply expire and another node picks the work up.
// - From the Nodes page a node can be drained (finishes what it is doing, takes nothing new) or disabled.
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, statfsSync, writeFileSync} from 'node:fs';
import {cpus, freemem, hostname, networkInterfaces, totalmem} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {db, cloud, primary, remoteRun, remoteAll, writes, sync} from './db.js';
import {tunnel, startTunnel} from './tunnel.js';
import {updateState, tick as updateTick, apply as applyUpdate, blocker as updateBlocker} from './updater.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iso = (t = Date.now()) => new Date(t).toISOString();
export const HEARTBEAT = 15e3;
export const STALE_AFTER = 45e3, OFFLINE_AFTER = 90e3; // heartbeat age; allows for a missed beat and sync delay

// ---------- identity ----------
const idFile = join(root, 'data', 'node.json');
function identity() {
  try { const j = JSON.parse(readFileSync(idFile, 'utf8')); if (j.id) return j; } catch {}
  const j = {id: randomUUID(), created: iso()};
  writeFileSync(idFile, JSON.stringify(j, null, 2));
  return j;
}
// A second server process on the same PC (see `primary` in db.js) is its own short-lived node.
export const NODE_ID = process.env.NODE_ID || (primary ? identity().id : `${identity().id.slice(0, 8)}-p${process.pid}`);
export const NODE_NAME = ((process.env.NODE_NAME || hostname()) + (primary || process.env.NODE_ID ? '' : ' (extra process)')).slice(0, 60);
// Version = package version + a fingerprint of the server code, so a node running older code stands out.
export const VERSION = (() => {
  let pkg = '0';
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0'; } catch {}
  const h = createHash('sha1');
  for (const f of readdirSync(join(root, 'server')).filter(f => f.endsWith('.js')).sort()) h.update(f).update(readFileSync(join(root, 'server', f)));
  return pkg + '+' + h.digest('hex').slice(0, 7);
})();
const started = iso();

db.exec(`CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT, version TEXT, platform TEXT,
  started_at TEXT, last_seen TEXT, mode TEXT NOT NULL DEFAULT 'active', stats TEXT
)`);
// lan_url: the home-network address; url: the address used from the internet when there is one.
if (!db.prepare(`SELECT 1 FROM pragma_table_info('nodes') WHERE name='lan_url'`).get()) try { db.exec(`ALTER TABLE nodes ADD COLUMN lan_url TEXT`); } catch {}
// command: a one-off request from the Nodes page for that node (e.g. 'update'), picked up by its next heartbeat.
if (!db.prepare(`SELECT 1 FROM pragma_table_info('nodes') WHERE name='command'`).get()) try { db.exec(`ALTER TABLE nodes ADD COLUMN command TEXT`); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, until TEXT NOT NULL)`);

// ---------- what this node is doing (filled in by the API and ranking modules) ----------
let statusOf = () => ({});
export const setStatusProvider = fn => { statusOf = fn; };
const done = []; // [time, kind] of finished work in the last hour
export function countWork(kind, n = 1) { const t = Date.now(); for (let i = 0; i < n; i++) done.push([t, kind]); }
const lastHour = () => { const cut = Date.now() - 3600e3; while (done.length && done[0][0] < cut) done.shift(); return done.reduce((m, [, k]) => (m[k] = (m[k] ?? 0) + 1, m), {}); };

// ---------- mode (active / draining / disabled) ----------
let mode = 'active';
export const isActive = () => mode === 'active';
export const currentMode = () => mode;

// ---------- leases ----------
// Takes (or renews) a job. Returns true when this node now holds it.
export async function claim(name, ms) {
  if (!isActive()) return false;
  const now = Date.now();
  try {
    const r = await remoteRun(`INSERT INTO leases (name, holder, until) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET holder=excluded.holder, until=excluded.until
      WHERE leases.holder=excluded.holder OR leases.until < ?
        OR leases.holder NOT IN (SELECT id FROM nodes WHERE last_seen > ?)`, [name, NODE_ID, iso(now + ms), iso(now), iso(now - OFFLINE_AFTER)]);
    return r.changes > 0;
  } catch (err) { console.error('[dashboard] lease failed:', err.message); return false; }
}
export async function release(name) {
  try { await remoteRun(`DELETE FROM leases WHERE name=? AND holder=?`, [name, NODE_ID]); } catch {}
}
// Jobs other live nodes are holding right now (from the local copy, at most a sync behind; claim() is the real check).
export function heldByOthers(prefix) {
  // A job held by a node that has gone offline counts as free.
  return new Set(db.prepare(`SELECT name FROM leases WHERE name LIKE ? AND holder<>? AND until>? AND holder IN (SELECT id FROM nodes WHERE last_seen>?)`)
    .all(prefix + '%', NODE_ID, iso(), iso(Date.now() - OFFLINE_AFTER)).map(r => r.name));
}
// How many nodes are sharing the work (active and heard from recently). At least 1.
export function activeWorkers() {
  const n = db.prepare(`SELECT count(*) n FROM nodes WHERE mode='active' AND last_seen>?`).get(iso(Date.now() - STALE_AFTER))?.n ?? 0;
  return Math.max(1, Number(n) + (isActive() && !db.prepare(`SELECT 1 FROM nodes WHERE id=? AND mode='active' AND last_seen>?`).get(NODE_ID, iso(Date.now() - STALE_AFTER)) ? 1 : 0));
}

// ---------- stats ----------
let lastCpu = null, port = null, localOnly = false;
// localOnly: the server only listens on this PC (e.g. `npm run dev` without --host).
export const setPort = (p, onlyLocal = false) => { port = p; localOnly = onlyLocal; if (!onlyLocal) startTunnel(p); };
function cpuPct() {
  const t = cpus().reduce((a, c) => { const tot = Object.values(c.times).reduce((x, y) => x + y, 0); return {idle: a.idle + c.times.idle, total: a.total + tot}; }, {idle: 0, total: 0});
  const prev = lastCpu; lastCpu = t;
  if (!prev || t.total === prev.total) return null;
  return Math.round(100 * (1 - (t.idle - prev.idle) / (t.total - prev.total)));
}
function disk() {
  try { const s = statfsSync(join(root, 'data')); return {free: s.bavail * s.bsize, total: s.blocks * s.bsize}; } catch { return null; }
}
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
  return 'localhost';
}
export const lanUrl = () => port ? `http://${localOnly ? 'localhost' : lanAddress()}:${port}` : null;
export const nodeUrl = () => process.env.PUBLIC_URL?.replace(/\/+$/, '') || tunnel.url || lanUrl();

function stats() {
  const s = statusOf() ?? {};
  return {
    cpu: cpuPct(), cpus: cpus().length, mem: {free: freemem(), total: totalmem()}, rss: process.memoryUsage().rss, disk: disk(),
    uptime: Math.round(process.uptime()), node: process.version, host: hostname(), work: lastHour(), current: s.current ?? null,
    rateLimitedUntil: s.rateLimitedUntil ?? null, update: updateSummary(), tunnel: tunnel.state === 'off' ? null : {state: tunnel.state, error: tunnel.error || null, since: tunnel.since}, db: cloud ? {writeMs: writes.direct ? Math.round(writes.directMs / writes.direct) : null, syncError: sync.error || null} : null
  };
}

// ---------- updates (see updater.js) ----------
const autoUpdate = () => { try { return JSON.parse(db.prepare(`SELECT value FROM settings WHERE key='nodes.autoUpdate'`).get()?.value ?? 'false') === true; } catch { return false; } };
function updateSummary() {
  const u = updateState();
  return {state: u.state, behind: u.behind, commit: u.commit, latest: u.latest, latestMessage: u.latestMessage, step: u.step,
    blocked: u.state === 'available' ? updateBlocker() : null, reason: u.reason, lastError: u.lastError, checkedAt: u.checkedAt, dev: u.dev};
}
const runUpdate = () => applyUpdate().then(r => { if (!r.ok) console.log('[dashboard] update: ' + r.message); return r; });

// ---------- heartbeat ----------
let timer = null, beats = 0, last = {ok: null, at: null, error: ''};
export const heartbeatState = () => ({...last});
async function beat() {
  try {
    await remoteRun(`INSERT INTO nodes (id, name, url, lan_url, version, platform, started_at, last_seen, stats) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, lan_url=excluded.lan_url, version=excluded.version, platform=excluded.platform,
      started_at=excluded.started_at, last_seen=excluded.last_seen, stats=excluded.stats`,
      [NODE_ID, NODE_NAME, nodeUrl(), lanUrl(), VERSION, process.platform, started, iso(), JSON.stringify(stats())]);
    // Every 10 minutes: forget nodes gone for a week, and extra-process nodes gone for an hour.
    if (beats++ % 40 === 0) await remoteRun(`DELETE FROM nodes WHERE last_seen < ? OR (id LIKE '%-p%' AND last_seen < ?)`, [iso(Date.now() - 7 * 864e5), iso(Date.now() - 3600e3)]);
    // The Nodes page may have changed this node's mode, or asked it to update.
    const row = (await remoteAll(`SELECT mode, command FROM nodes WHERE id=?`, [NODE_ID]))[0];
    if (row && row.mode !== mode) { console.log(`[dashboard] node mode: ${mode} -> ${row.mode}`); mode = row.mode; }
    if (row?.command) { await remoteRun(`UPDATE nodes SET command=NULL WHERE id=?`, [NODE_ID]); if (row.command === 'update') runUpdate(); }
    // About every 10 minutes (first after a minute): look for updates on GitHub, and install them if that's switched on.
    if (beats % 40 === 4) updateTick({auto: autoUpdate(), busy: !!statusOf()?.current}).catch(err => console.error('[dashboard] update check failed:', err.message));
    last = {ok: true, at: iso(), error: ''};
  } catch (err) { last = {ok: false, at: iso(), error: err.message}; }
}
export function startHeartbeat() {
  stopHeartbeat();
  cpuPct();
  beat();
  timer = setInterval(beat, HEARTBEAT);
  timer.unref?.();
}
// On a clean stop, hand jobs back at once instead of waiting for them to expire.
export function stopHeartbeat() {
  clearInterval(timer); timer = null;
  remoteRun(`DELETE FROM leases WHERE holder=?`, [NODE_ID]).catch(() => {});
}

// ---------- Nodes page ----------
const health = lastSeen => { const age = Date.now() - Date.parse(lastSeen); return age < STALE_AFTER ? 'healthy' : age < OFFLINE_AFTER ? 'stale' : 'offline'; };
export async function nodesData() {
  const rows = await remoteAll(`SELECT * FROM nodes ORDER BY started_at`);
  const leases = await remoteAll(`SELECT * FROM leases WHERE until>? AND holder IN (SELECT id FROM nodes WHERE last_seen>?)`, [iso(), iso(Date.now() - OFFLINE_AFTER)]);
  const versions = rows.filter(r => health(r.last_seen) !== 'offline').map(r => r.version);
  const newest = versions.sort().at(-1) ?? VERSION;
  return {
    self: NODE_ID, now: iso(), autoUpdate: autoUpdate(), heartbeat: HEARTBEAT / 1000, staleAfter: STALE_AFTER / 1000, offlineAfter: OFFLINE_AFTER / 1000, cloud,
    nodes: rows.map(r => ({...r, stats: (() => { try { return JSON.parse(r.stats); } catch { return null; } })(), health: health(r.last_seen),
      outdated: r.version !== newest && versions.length > 1, leases: leases.filter(l => l.holder === r.id).map(l => ({name: l.name, until: l.until}))})),
    leases: leases.map(l => ({...l, node: rows.find(r => r.id === l.holder)?.name ?? 'unknown'}))
  };
}
export async function setNodeMode(id, next) {
  if (!['active', 'draining', 'disabled'].includes(next)) throw Object.assign(new Error('Unknown mode.'), {status: 400});
  await remoteRun(`UPDATE nodes SET mode=? WHERE id=?`, [next, id]);
  if (id === NODE_ID) mode = next;
  // A disabled node gives its jobs back straight away so others can take them.
  if (next === 'disabled') await remoteRun(`DELETE FROM leases WHERE holder=?`, [id]);
}
export async function removeNode(id) {
  const row = (await remoteAll(`SELECT last_seen FROM nodes WHERE id=?`, [id]))[0];
  if (!row) return;
  if (id === NODE_ID || health(row.last_seen) !== 'offline') throw Object.assign(new Error('Only offline nodes can be removed. Stop it first (it would sign itself in again).'), {status: 409});
  await remoteRun(`DELETE FROM leases WHERE holder=?`, [id]);
  await remoteRun(`DELETE FROM nodes WHERE id=?`, [id]);
}

// ---------- updates from the Nodes page ----------
// This node updates at once (the answer says how it went); another node gets the request with its next heartbeat.
export async function requestUpdate(id) {
  if (id === NODE_ID) return runUpdate();
  const row = (await remoteAll(`SELECT last_seen FROM nodes WHERE id=?`, [id]))[0];
  if (!row) throw Object.assign(new Error('Unknown node.'), {status: 404});
  if (health(row.last_seen) === 'offline') throw Object.assign(new Error('That node is offline.'), {status: 409});
  await remoteRun(`UPDATE nodes SET command='update' WHERE id=?`, [id]);
  return {ok: true, message: 'Update requested. The node installs it within 15 seconds and restarts.'};
}
export async function setAutoUpdate(on) {
  await remoteRun(`INSERT INTO settings (key, value) VALUES ('nodes.autoUpdate', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(!!on)]);
}
