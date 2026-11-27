// Vercel function: Google Trends when no node can answer (the page asks a node first; see src/pages/trends.jsx).
// GET /api/trends?kind=explore&q=...&geo=IN&prop=web&time=now%201-d   or   ?kind=trending&geo=IN
// Needs the same sign-in pass as the nodes. Google limits cloud servers more than home connections, so this can
// answer 429 more often than a node does.
import {checkToken, bearer} from '../server/auth.js';
import {explore, trending} from '../server/gtrends.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkToken(bearer(req), process.env.AUTH_SECRET)) return res.status(401).json({error: 'Please sign in again.', auth: true});
  const q = req.query ?? {};
  try {
    const data = q.kind === 'trending' ? await trending({geo: q.geo}) : await explore({q: q.q, geo: q.geo, prop: q.prop, time: q.time});
    return res.status(200).json({...data, via: 'vercel'});
  } catch (err) {
    return res.status(err.status ?? 502).json({error: err.message});
  }
}
