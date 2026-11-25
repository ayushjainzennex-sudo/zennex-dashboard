// Remote mode: the page is hosted on Vercel (built with VITE_REMOTE=1) and talks to the nodes directly.
// - Sign in once: /api/login on Vercel returns a signed pass, kept in this browser for 30 days.
// - /api/registry lists the nodes that are online; each is timed and the fastest one is used.
// - If a node stops answering, the next fastest takes over (reads are retried; writes are never repeated).
// When the page is served by a node itself (http://192.168.x.x:4173), none of this applies.
export const REMOTE = import.meta.env.VITE_REMOTE === '1';

const KEY = 'cs.pass', PICK = 'cs.node';
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
};

export function pass() {
  try { const p = JSON.parse(store.get(KEY)); return p && Date.parse(p.exp) > Date.now() ? p.token : null; } catch { return null; }
}
const listeners = new Set();
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(fn => fn(state()));

export async function signIn(password) {
  const r = await fetch('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password})});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Sign-in failed.');
  store.set(KEY, JSON.stringify(data));
  current = null; emit();
}
export function signOut() { store.set(KEY, null); store.set(PICK, null); current = null; nodes = []; emit(); }

// ---------- choosing a node ----------
let nodes = [], current = null, choosing = null, bad = new Map(); // node id -> time it failed
export const state = () => ({signedIn: !!pass(), node: current, nodes});

async function time(url) {
  const t0 = performance.now();
  try { const r = await fetch(url + '/api/node/ping', {cache: 'no-store', signal: AbortSignal.timeout(5000)}); if (!r.ok) return null; await r.json(); return Math.round(performance.now() - t0); }
  catch { return null; }
}
async function choose() {
  const r = await fetch('/api/registry', {headers: {Authorization: 'Bearer ' + pass()}, cache: 'no-store'});
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { signOut(); throw Object.assign(new Error('Please sign in again.'), {auth: true}); }
  if (!r.ok) throw new Error(data.error || 'Could not get the list of nodes.');
  const usable = data.nodes.filter(n => n.reachable && n.mode === 'active');
  const timed = await Promise.all(usable.map(async n => ({...n, ms: await time(n.url)})));
  nodes = timed.sort((a, b) => (a.ms ?? 1e9) - (b.ms ?? 1e9));
  const fresh = Date.now() - 2 * 60e3;
  current = nodes.find(n => n.ms != null && !(bad.get(n.id) > fresh)) ?? nodes.find(n => n.ms != null) ?? null;
  store.set(PICK, current?.id ?? null);
  emit();
  if (!current) throw new Error(usable.length ? 'No node is answering right now. Are the PCs on?' : 'No node is online. Start one of your PCs (or its node) and try again.');
  return current;
}
const node = () => current ? Promise.resolve(current) : (choosing ??= choose().finally(() => { choosing = null; }));
export function refreshNodes() { current = null; return node(); }
// Re-time the nodes every few minutes so the page moves to a faster one if things change.
if (REMOTE && typeof window !== 'undefined') setInterval(() => { if (pass() && !document.hidden) refreshNodes().catch(() => {}); }, 3 * 60e3);

// fetch() for API paths ("/api/..."): to the chosen node, with the pass.
export async function nodeFetch(path, init = {}) {
  if (!REMOTE) return fetch(path, init);
  if (!pass()) throw Object.assign(new Error('Please sign in.'), {auth: true});
  const read = !init.method || init.method === 'GET';
  for (let attempt = 0; ; attempt++) {
    const n = await node();
    try {
      const r = await fetch(n.url + path, {...init, headers: {...init.headers, Authorization: 'Bearer ' + pass()}});
      if (r.status === 401) { signOut(); throw Object.assign(new Error('Please sign in again.'), {auth: true}); }
      return r;
    } catch (err) {
      if (err.auth || err.name === 'TimeoutError' || err.name === 'AbortError') throw err;
      // The node did not answer: try the next one. Writes are not repeated (they may have gone through).
      bad.set(n.id, Date.now()); current = null;
      if (!read || attempt >= 2) throw err;
    }
  }
}
