// Vercel function: POST /api/login {password} -> a signed pass the nodes accept (see server/auth.js).
// Vercel environment variables: DASHBOARD_PASSWORD, AUTH_SECRET (the same AUTH_SECRET as in every node's .env).
import {makeToken, samePassword} from '../server/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({error: 'Use POST.'});
  const {DASHBOARD_PASSWORD, AUTH_SECRET} = process.env;
  if (!DASHBOARD_PASSWORD || !AUTH_SECRET) return res.status(500).json({error: 'Login is not set up: add DASHBOARD_PASSWORD and AUTH_SECRET in Vercel.'});
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : req.body ?? {};
  if (!samePassword(body.password, DASHBOARD_PASSWORD)) {
    await new Promise(r => setTimeout(r, 700)); // slows down guessing
    return res.status(401).json({error: 'Wrong password.'});
  }
  return res.status(200).json(makeToken(AUTH_SECRET));
}
