// Vercel function: GET /api/registry -> the nodes the page can use (online, taking requests, with an https address).
// Reads the heartbeats straight from Turso. Vercel environment variables: DATABASE_URL, DATABASE_TOKEN
// (a read-only token is enough), AUTH_SECRET.
import {createClient} from '@libsql/client/web';
import {checkToken, bearer} from '../server/auth.js';

const OFFLINE_AFTER = 90e3, STALE_AFTER = 45e3;
let client = null;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkToken(bearer(req), process.env.AUTH_SECRET)) return res.status(401).json({error: 'Please sign in again.', auth: true});
  if (!process.env.DATABASE_URL) return res.status(500).json({error: 'DATABASE_URL is not set in Vercel.'});
  try {
    client ??= createClient({url: process.env.DATABASE_URL.replace(/^libsql:/, 'https:'), authToken: process.env.DATABASE_TOKEN});
    const cut = new Date(Date.now() - OFFLINE_AFTER).toISOString();
    const r = await client.execute({sql: `SELECT id, name, url, version, mode, last_seen FROM nodes WHERE last_seen > ? ORDER BY last_seen DESC`, args: [cut]});
    const nodes = r.rows.map(n => ({id: n.id, name: n.name, url: n.url, version: n.version, mode: n.mode, lastSeen: n.last_seen,
      health: Date.now() - Date.parse(n.last_seen) < STALE_AFTER ? 'healthy' : 'stale', reachable: /^https:\/\//.test(n.url ?? '') || (process.env.REGISTRY_ALLOW_HTTP === '1' && /^http:\/\//.test(n.url ?? ''))}));
    return res.status(200).json({nodes, now: new Date().toISOString()});
  } catch (err) {
    return res.status(502).json({error: 'Could not read the node list: ' + err.message});
  }
}
