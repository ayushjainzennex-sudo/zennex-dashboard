// Vercel function: GET /api/snapshot -> the dashboard copy the nodes save in Turso (see server/snapshot.js),
// shown read-only when no node is online. Needs the same sign-in pass as the nodes.
// Vercel environment variables: DATABASE_URL, DATABASE_TOKEN (a read-only token is enough), AUTH_SECRET.
import {createClient} from '@libsql/client/web';
import {checkToken, bearer} from '../server/auth.js';

let client = null;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkToken(bearer(req), process.env.AUTH_SECRET)) return res.status(401).json({error: 'Please sign in again.', auth: true});
  if (!process.env.DATABASE_URL) return res.status(500).json({error: 'DATABASE_URL is not set in Vercel.'});
  try {
    client ??= createClient({url: process.env.DATABASE_URL.replace(/^libsql:/, 'https:'), authToken: process.env.DATABASE_TOKEN});
    const r = await client.execute(`SELECT value FROM settings WHERE key='dashboard.snapshot'`);
    if (!r.rows.length) return res.status(404).json({error: 'No saved copy yet. A node saves one within about 10 minutes of starting.'});
    const {at, gz} = JSON.parse(r.rows[0].value);
    // Sent as stored (gzipped); the browser unpacks it.
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('X-Snapshot-At', at);
    return res.status(200).end(Buffer.from(gz, 'base64'));
  } catch (err) {
    return res.status(502).json({error: 'Could not read the saved copy: ' + err.message});
  }
}
