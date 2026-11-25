// Automatic backups of the SQLite database.
// - A consistent copy is written with VACUUM INTO (safe while the app is running), then checked.
// - Kept: one per day for 14 days plus the 3 newest. Optional second folder (e.g. a Google Drive / OneDrive folder).
// - Runs on start when the last backup is over 20 hours old, then checks every hour.
import {DatabaseSync} from 'node:sqlite';
import {copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {db, backupDir} from './db.js';

// How many days to keep and how often to back up come from the Database page settings.
const KEEP_LATEST = 3;
const cfg = () => ({...{backupKeepDays: 14, backupEveryHours: 24}, ...read('db.settings', {})});
const NAME = /^dashboard-(\d{4}-\d{2}-\d{2})_(\d{4})\.db$/;
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
const read = (k, d) => { const r = db.prepare(`SELECT value FROM settings WHERE key=?`).get(k); return r ? JSON.parse(r.value) : d; };
const write = (k, v) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, JSON.stringify(v));

const stamp = d => d.toISOString().slice(0, 10) + '_' + d.toISOString().slice(11, 16).replace(':', '');
const list = dir => existsSync(dir) ? readdirSync(dir).filter(f => NAME.test(f)).sort().reverse()
  .map(f => { const st = statSync(join(dir, f)); return {name: f, size: st.size, at: st.mtime.toISOString()}; }) : [];

function verify(file) {
  const check = new DatabaseSync(file, {readOnly: true});
  try { return check.prepare('PRAGMA quick_check').get()?.quick_check === 'ok'; } finally { check.close(); }
}
function prune(dir) {
  const files = list(dir), keepDays = new Set(), now = Date.now();
  files.forEach((f, i) => {
    const day = NAME.exec(f.name)[1];
    const recent = now - Date.parse(day) < cfg().backupKeepDays * 86400e3;
    if (i < KEEP_LATEST || (recent && !keepDays.has(day))) { keepDays.add(day); return; }
    rmSync(join(dir, f.name), {force: true});
  });
}

export function backupSettings() {
  return {mirror: read('backup.mirror', ''), last: read('backup.last', null), error: read('backup.error', ''), dir: backupDir, files: list(backupDir)};
}
export function setMirror(dir) {
  dir = String(dir ?? '').trim();
  if (dir) { const abs = resolve(dir); mkdirSync(abs, {recursive: true}); dir = abs; }
  write('backup.mirror', dir);
  return backupSettings();
}

export function backupNow() {
  mkdirSync(backupDir, {recursive: true});
  const name = `dashboard-${stamp(new Date())}.db`, tmp = join(backupDir, name + '.tmp'), out = join(backupDir, name);
  try {
    rmSync(tmp, {force: true});
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    if (!verify(tmp)) throw new Error('The backup copy failed its integrity check.');
    renameSync(tmp, out);
    prune(backupDir);
    const mirror = read('backup.mirror', '');
    if (mirror) { mkdirSync(mirror, {recursive: true}); copyFileSync(out, join(mirror, name)); prune(mirror); }
    write('backup.last', new Date().toISOString()); write('backup.error', '');
    return backupSettings();
  } catch (err) {
    rmSync(tmp, {force: true});
    write('backup.error', err.message);
    console.error('[dashboard] backup failed:', err.message);
    throw err;
  }
}

let timer = null, first = null;
export function startBackups() {
  stopBackups();
  const tick = () => {
    const last = read('backup.last', null);
    // A little early is fine (e.g. 20h for a daily backup) so the time of day doesn't drift later.
    if (!last || Date.now() - Date.parse(last) > cfg().backupEveryHours * 3600e3 * 0.85) { try { backupNow(); } catch {} }
  };
  first = setTimeout(tick, 15e3);   // shortly after start (catches up after the PC was off)
  timer = setInterval(tick, 3600e3); // then hourly checks; a backup is made once 20+ hours have passed
}
export function stopBackups() { clearTimeout(first); clearInterval(timer); timer = first = null; }
