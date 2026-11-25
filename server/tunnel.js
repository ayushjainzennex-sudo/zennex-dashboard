// Cloudflare quick tunnel: gives a node a public https address (https://<random>.trycloudflare.com) without
// a domain, an account or opening ports on the router. Turned on with TUNNEL=quick in .env; needs `cloudflared`
// installed (Windows: winget install --id Cloudflare.cloudflared). The address changes every time the tunnel
// starts; the node reports the current one in its heartbeat, so the Vercel page always finds it.
// For a fixed address (your own domain, a named tunnel, a VPS), set PUBLIC_URL instead.
import {spawn} from 'node:child_process';

export const tunnel = {url: null, state: 'off', error: '', since: null};
let child = null, port = null, retry = null, delay = 5e3, stopping = false;

export function startTunnel(p) {
  if (String(process.env.TUNNEL ?? '').toLowerCase() !== 'quick' || child || retry) return;
  if (!process.env.AUTH_SECRET) {
    tunnel.state = 'refused'; tunnel.error = 'AUTH_SECRET is not set, so the tunnel stays off (the API would be open to the internet).';
    console.warn('[dashboard] tunnel: ' + tunnel.error);
    return;
  }
  port = p; stopping = false;
  open();
}
function open() {
  retry = null;
  tunnel.state = 'starting'; tunnel.error = '';
  try {
    child = spawn(process.env.CLOUDFLARED || 'cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (err) { return failed(err.message); }
  const read = chunk => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(String(chunk));
    if (m && tunnel.url !== m[0]) { tunnel.url = m[0]; tunnel.state = 'up'; tunnel.since = new Date().toISOString(); delay = 5e3; console.log(`[dashboard] tunnel: ${tunnel.url}`); }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  child.on('error', err => failed(err.code === 'ENOENT' ? 'cloudflared is not installed (Windows: winget install --id Cloudflare.cloudflared).' : err.message));
  child.on('exit', code => { child = null; tunnel.url = null; if (!stopping) failed(`cloudflared stopped (code ${code}).`); });
}
function failed(message) {
  child = null; tunnel.url = null; tunnel.state = 'down'; tunnel.error = message;
  console.warn(`[dashboard] tunnel: ${message} Retrying in ${Math.round(delay / 1000)} s.`);
  clearTimeout(retry);
  retry = setTimeout(open, delay); retry.unref?.();
  delay = Math.min(delay * 2, 5 * 60e3);
}
export function stopTunnel() {
  stopping = true; clearTimeout(retry); retry = null;
  try { child?.kill(); } catch {}
  child = null; tunnel.url = null; tunnel.state = 'off';
}
process.on('exit', () => { try { child?.kill(); } catch {} });
