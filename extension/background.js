// Channel Studio: exact upload dates.
// Every minute: ask the dashboard which videos only have estimated dates, open each video's page
// in the background (slowly, with random gaps), read its exact publish date, and send the dates back.

const DEFAULTS = {dashboard: 'http://localhost:4173', enabled: true, batch: 8};
const get = async () => ({...DEFAULTS, ...(await chrome.storage.local.get(null))});
const set = obj => chrome.storage.local.set(obj);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => 4000 + Math.random() * 5000; // 4–9 s between videos

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('tick', {periodInMinutes: 1}));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('tick', {periodInMinutes: 1}));
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'tick') run(); });
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === 'run') { set({pausedUntil: 0}).then(() => run(true)).then(() => reply(true)); return true; }
});

// Exact publish date from a video page, or null (private / removed / not found).
async function readDate(id) {
  const res = await fetch('https://www.youtube.com/watch?v=' + id + '&hl=en', {credentials: 'omit'});
  if (res.status === 429 || res.url.includes('/sorry/')) throw Object.assign(new Error('YouTube is rate limiting'), {limited: true});
  if (!res.ok) return null;
  const html = await res.text();
  return /"publishDate":"([^"]+)"/.exec(html)?.[1] ?? /itemprop="datePublished" content="([^"]+)"/.exec(html)?.[1] ?? null;
}

let busy = false;
async function run(manual = false) {
  if (busy) return;
  const cfg = await get();
  if (!cfg.enabled && !manual) return;
  if (!manual && cfg.pausedUntil && Date.now() < cfg.pausedUntil) return;
  busy = true;
  const base = cfg.dashboard.replace(/\/+$/, '');
  const skip = new Set(cfg.skip ?? []);
  try {
    const pending = await fetch(base + '/api/dates/pending?limit=' + (cfg.batch + skip.size)).then(r => { if (!r.ok) throw new Error('Dashboard returned ' + r.status); return r.json(); });
    const ids = pending.ids.filter(id => !skip.has(id)).slice(0, cfg.batch);
    await set({lastCheck: Date.now(), remaining: pending.remaining, done: pending.done, error: ''});
    const dates = [];
    for (const [i, id] of ids.entries()) {
      try {
        const published = await readDate(id);
        if (published) dates.push({id, published}); else skip.add(id);
      } catch (err) {
        if (err.limited) { await set({pausedUntil: Date.now() + 30 * 60e3, error: 'YouTube asked to slow down. Paused for 30 minutes.'}); break; }
      }
      if (i < ids.length - 1) await sleep(jitter());
    }
    if (dates.length) {
      const out = await fetch(base + '/api/dates', {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: JSON.stringify({dates})}).then(r => r.json());
      await set({remaining: out.remaining, done: out.done, lastSaved: Date.now(), savedTotal: (cfg.savedTotal ?? 0) + out.saved});
    }
    await set({skip: [...skip].slice(-500)});
  } catch (err) {
    await set({error: 'Can’t reach the dashboard at ' + base + ' (' + err.message + ')'});
  } finally {
    busy = false;
  }
}
