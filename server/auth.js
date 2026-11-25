// Signed passes for using the dashboard over the internet (Vercel frontend -> nodes).
// The Vercel login function signs a pass with AUTH_SECRET after checking DASHBOARD_PASSWORD; every node has
// the same AUTH_SECRET in its .env and checks the signature. Nothing is stored anywhere.
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

const b64 = buf => Buffer.from(buf).toString('base64url');
const sign = (data, secret) => b64(createHmac('sha256', secret).update(data).digest());
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export const TOKEN_DAYS = 30;
export function makeToken(secret, days = TOKEN_DAYS) {
  const body = b64(JSON.stringify({v: 1, iat: Date.now(), exp: Date.now() + days * 864e5}));
  return {token: body + '.' + sign(body, secret), exp: new Date(Date.now() + days * 864e5).toISOString()};
}
export function checkToken(token, secret) {
  if (!secret || typeof token !== 'string') return false;
  const [body, sig] = token.split('.');
  if (!body || !sig || !same(sig, sign(body, secret))) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
export const bearer = req => /^Bearer\s+(.+)$/i.exec(req.headers?.authorization ?? '')?.[1] ?? null;
// Compares passwords without leaking their length or content through timing.
export const samePassword = (given, expected) => same(createHash('sha256').update(String(given ?? '')).digest('hex'), createHash('sha256').update(String(expected ?? '')).digest('hex'));

// Is this request from this PC or the home network, directly (not through a tunnel or proxy)?
const PRIVATE = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd)/i;
// The Host must also be an address of this PC (an IP, localhost or its name): a web page that tricks the
// browser into calling the home network under another name (DNS rebinding) is treated as the internet.
const LOCAL_HOST = /^(\[[0-9a-f:.]+\]|[\d.]+|localhost|[a-z0-9-]+|[a-z0-9-]+\.(local|lan|home|internal))(:\d+)?$/i;
export function isLocal(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['forwarded']) return false;
  if (!LOCAL_HOST.test(req.headers.host ?? '')) return false;
  const ip = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return PRIVATE.test(ip);
}
