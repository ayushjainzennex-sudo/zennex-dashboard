// A saved copy of the dashboard in the shared database, for when no node is online.
//
// The page on Vercel normally gets its data from a node. When none is answering it shows this copy instead
// (read-only), served by the Vercel function api/snapshot.js straight from Turso. Every node with the cloud
// database writes the copy about every 10 minutes; if another node wrote one recently, it skips its turn.
// Stored gzipped (≈85 KB instead of ≈600 KB of JSON) in the settings table:
//   dashboard.snapshot   = {"at": ISO time, "gz": base64 of the gzipped /api/dashboard JSON}
//   dashboard.snapshotAt = ISO time (small, so checking whether a fresh copy exists is cheap)
import {gzipSync} from 'node:zlib';
import {cloud, remoteAll, remoteRun} from './db.js';

const EVERY = 10 * 60e3;
const put = (key, value) => remoteRun(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]);
let first = null, timer = null;

async function save(build) {
  try {
    const last = (await remoteAll(`SELECT value FROM settings WHERE key='dashboard.snapshotAt'`))[0]?.value;
    if (last && Date.now() - Date.parse(JSON.parse(last)) < EVERY * .8) return;   // another node saved one just now
    const at = new Date().toISOString();
    const gz = gzipSync(JSON.stringify(build())).toString('base64');
    await put('dashboard.snapshot', JSON.stringify({at, gz}));
    await put('dashboard.snapshotAt', JSON.stringify(at));
  } catch (err) { console.error('[dashboard] saving the dashboard copy failed:', err.message); }
}

// `build` returns the same data as GET /api/dashboard.
export function startSnapshots(build) {
  stopSnapshots();
  if (!cloud) return;   // only the shared database is reachable from Vercel
  first = setTimeout(() => save(build), 60e3);
  timer = setInterval(() => save(build), EVERY);
  first.unref?.(); timer.unref?.();
}
export function stopSnapshots() { clearTimeout(first); clearInterval(timer); first = timer = null; }
