// Vercel function: topic research when no node can answer (the page asks a node first).
// GET /api/research?kind=ideas&q=...&geo=IN   or   ?kind=score&q=...&geo=IN
// Without the database, so competitor videos and your coverage are left out. Part of topic-research (RESEARCH.md).
import {checkToken, bearer} from '../server/auth.js';
import {ideas, score, compare, angles} from '../server/research.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkToken(bearer(req), process.env.AUTH_SECRET)) return res.status(401).json({error: 'Please sign in again.', auth: true});
  const {kind, q, geo = 'IN'} = req.query ?? {};
  try {
    const data = kind === 'score' ? await score(q, geo) : kind === 'compare' ? await compare(q, geo) : kind === 'angles' ? await angles(q, geo) : await ideas(q, geo);
    return res.status(200).json({...data, via: 'vercel'});
  } catch (err) {
    return res.status(err.status ?? 502).json({error: err.message});
  }
}
