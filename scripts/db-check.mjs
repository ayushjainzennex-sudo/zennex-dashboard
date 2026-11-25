// Checks the cloud database from .env before the dashboard is switched over to it.
// Run: npm run db:check
// Uses a throwaway local copy (data/check-replica.db) and a throwaway table, both removed afterwards.
import {createRequire} from 'node:module';
import {existsSync, rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const url = process.env.DATABASE_URL, authToken = process.env.DATABASE_TOKEN;
if (!url) { console.log('DATABASE_URL is not set in .env. Nothing to check.'); process.exit(1); }

const Database = createRequire(import.meta.url)('libsql');
const file = join(root, 'data', 'check-replica.db');
const clear = () => { for (const ext of ['', '-wal', '-shm', '-info', '-client_wal_index']) try { rmSync(file + ext, {force: true}); } catch {} };
clear();
let failed = 0;
const step = (name, fn) => {
  const t0 = Date.now();
  try { const r = fn(); console.log(`  ok    ${name} (${Date.now() - t0} ms)${r ? ' - ' + r : ''}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}: ${err.message}`); }
};

console.log(`Checking ${url.replace(/\?.*/, '')}`);
let db;
step('connect and download a copy', () => { db = new Database(file, {syncUrl: url, authToken}); db.sync(); });
if (!db) process.exit(1);
step('your data is there', () => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'`).all().map(r => r.name);
  if (!tables.includes('channels')) throw new Error('no "channels" table. Was the database created from turso-upload.db?');
  const n = tables.reduce((t, name) => t + db.prepare(`SELECT count(*) n FROM "${name}"`).get().n, 0);
  return `${tables.length} tables, ${n.toLocaleString('en-IN')} rows`;
});
step('write', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS _node_check_parent (id INTEGER PRIMARY KEY, v TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS _node_check_child (parent INTEGER REFERENCES _node_check_parent(id) ON DELETE CASCADE)`);
  db.prepare(`INSERT INTO _node_check_parent (v) VALUES (?)`).run('hello');
});
step('read your own write straight away', () => {
  const r = db.prepare(`SELECT v FROM _node_check_parent ORDER BY id DESC LIMIT 1`).get();
  if (r?.v !== 'hello') throw new Error('the write is not visible yet');
});
step('transaction (all-or-nothing)', () => {
  db.exec('BEGIN');
  db.prepare(`INSERT INTO _node_check_parent (v) VALUES (?)`).run('rolled back');
  db.exec('ROLLBACK');
  if (db.prepare(`SELECT 1 FROM _node_check_parent WHERE v='rolled back'`).get()) throw new Error('rollback did not undo the insert');
});
step('linked rows are removed together', () => {
  db.exec('PRAGMA foreign_keys = ON');
  const id = db.prepare(`INSERT INTO _node_check_parent (v) VALUES ('p')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO _node_check_child (parent) VALUES (?)`).run(id);
  db.prepare(`DELETE FROM _node_check_parent WHERE id=?`).run(id);
  if (db.prepare(`SELECT 1 FROM _node_check_child WHERE parent=?`).get(id)) throw new Error('child row was left behind (ON DELETE CASCADE not applied)');
});
step('write speed (10 single writes)', () => {
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) db.prepare(`INSERT INTO _node_check_parent (v) VALUES (?)`).run('speed');
  return `${Math.round((Date.now() - t0) / 10)} ms per write`;
});
step('sync', () => { const t0 = Date.now(); db.sync(); return `${Date.now() - t0} ms`; });
step('clean up', () => { db.exec(`DROP TABLE IF EXISTS _node_check_child; DROP TABLE IF EXISTS _node_check_parent;`); });
db.close();
clear();
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll good. The dashboard can use this database.');
process.exit(failed ? 1 : 0);
