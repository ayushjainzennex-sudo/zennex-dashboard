// Webhook notifications (Discord, Slack). URLs are stored in the local database and never sent back to the browser in full.
import {db} from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

export const KINDS = ['outlier', 'milestone', 'upload', 'ranking', 'published'];
export const SERVICES = {
  discord: {
    name: 'Discord',
    valid: u => /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(u),
    hint: 'https://discord.com/api/webhooks/…',
    payload: (a, link) => {
      const r = rich(a, link);
      const lines = r.lines.map(l => `${l.rank ? '`' + l.rank + '`  ' : ''}**${trim(l.text, 60)}**${l.note ? '  ·  ' + (l.url ? `[${l.note}](${l.url})` : l.note) : l.url ? `  [open](${l.url})` : ''}`);
      return {username: 'Channel Studio', embeds: [{title: r.heading, color: COLORS[r.severity] ?? COLORS.info,
        description: [r.summary, ...lines, r.more ? `_+${r.more} more_` : ''].filter(Boolean).join('\n').slice(0, 3800), footer: {text: r.footer}}]};
    }
  },
  slack: {
    name: 'Slack',
    valid: u => /^https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[\w/-]+$/.test(u),
    hint: 'https://hooks.slack.com/services/…',
    payload: (a, link) => {
      const r = rich(a, link), esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const lines = r.lines.map(l => `${l.rank ? '`' + l.rank + '`  ' : ''}*${esc(trim(l.text, 60))}*${l.note ? '  ·  ' + (l.url ? `<${l.url}|${esc(l.note)}>` : esc(l.note)) : l.url ? `  <${l.url}|open>` : ''}`);
      const blocks = [{type: 'section', text: {type: 'mrkdwn', text: `*${esc(r.heading)}*${r.summary ? '\n' + esc(r.summary) : ''}`}}];
      if (lines.length) blocks.push({type: 'section', text: {type: 'mrkdwn', text: lines.join('\n') + (r.more ? `\n_+${r.more} more_` : '')}});
      blocks.push({type: 'context', elements: [{type: 'mrkdwn', text: esc(r.footer)}]});
      return {text: r.heading, attachments: [{color: '#' + (COLORS[r.severity] ?? COLORS.info).toString(16).padStart(6, '0'), blocks}]};
    }
  }
};

// Alerts may carry structured content (`rich`); plain alerts are adapted to the same shape.
const COLORS = {critical: 0xff453a, high: 0xff9f0a, medium: 0xffd60a, info: 0x8e8e93, resolved: 0x30d158, ok: 0x30d158};
const trim = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function rich(a, link) {
  if (a.rich) return a.rich;
  const body = String(a.body ?? '').split('\n').filter(Boolean);
  return {severity: a.kind === 'test' ? 'ok' : a.kind === 'outlier' || a.kind === 'milestone' ? 'resolved' : 'info', heading: a.title, summary: body[0] ?? '',
    lines: link ? [{rank: '', text: body[1] ?? 'Open video', note: '', url: link}] : body.slice(1, 4).map(t => ({rank: '', text: t, note: ''})), more: 0, footer: 'Channel Studio'};
}

const read = service => {
  const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get('webhook.' + service);
  const saved = row ? JSON.parse(row.value) : null;
  // Backwards compatible: DISCORD_WEBHOOK_URL env var still works when nothing is saved.
  if (!saved && service === 'discord' && process.env.DISCORD_WEBHOOK_URL) return {url: process.env.DISCORD_WEBHOOK_URL, enabled: true, kinds: KINDS, fromEnv: true};
  return saved ?? {url: '', enabled: false, kinds: KINDS};
};
const write = (service, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('webhook.' + service, JSON.stringify(value));
const mask = url => { try { const u = new URL(url); const tail = u.pathname.split('/').pop(); return u.host + '/…/' + tail.slice(0, 4) + '•••' + tail.slice(-4); } catch { return ''; } };

export function notificationSettings() {
  return Object.fromEntries(Object.keys(SERVICES).map(s => {
    const c = read(s);
    return [s, {configured: !!c.url, masked: c.url ? mask(c.url) : '', enabled: !!c.enabled && !!c.url, kinds: c.kinds ?? KINDS, fromEnv: !!c.fromEnv, lastError: c.lastError ?? null, lastSent: c.lastSent ?? null, hint: SERVICES[s].hint}];
  }));
}

export function saveNotification(service, {url, enabled, kinds}) {
  if (!SERVICES[service]) throw Object.assign(new Error('Unknown service.'), {status: 400});
  const current = read(service);
  const next = {...current, fromEnv: undefined};
  if (url !== undefined) {
    const value = String(url).trim();
    if (value && !SERVICES[service].valid(value)) throw Object.assign(new Error(`That doesn't look like a ${SERVICES[service].name} webhook URL (${SERVICES[service].hint}).`), {status: 400});
    next.url = value; next.lastError = null;
    if (!value) next.enabled = false;
  }
  if (enabled !== undefined) next.enabled = !!enabled && !!next.url;
  if (Array.isArray(kinds)) next.kinds = kinds.filter(k => KINDS.includes(k));
  write(service, next);
}

async function post(service, alert) {
  const c = read(service);
  const link = alert.video ? 'https://youtu.be/' + alert.video : null;
  try {
    const res = await fetch(c.url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(SERVICES[service].payload(alert, link)), signal: AbortSignal.timeout(10000)});
    if (!res.ok) throw new Error(`${SERVICES[service].name} returned ${res.status}${res.status === 404 ? ' (webhook deleted?)' : ''}.`);
    if (!c.fromEnv) write(service, {...c, lastError: null, lastSent: new Date().toISOString()});
  } catch (err) {
    if (!c.fromEnv) write(service, {...c, lastError: err.message});
    throw err;
  }
}

// Fan an alert out to every enabled webhook that wants this kind. Failures are recorded, never thrown.
// 'system' alerts (the dashboard itself has a problem, e.g. YouTube pages can't be read) always go out.
export function notify(alert) {
  for (const s of Object.keys(SERVICES)) {
    const c = read(s);
    if (c.url && c.enabled && (alert.kind === 'system' || (c.kinds ?? KINDS).includes(alert.kind))) post(s, alert).catch(() => {});
  }
}

export async function sendTest(service) {
  if (!SERVICES[service]) throw Object.assign(new Error('Unknown service.'), {status: 400});
  if (!read(service).url) throw Object.assign(new Error('Save a webhook URL first.'), {status: 400});
  const fail = err => { throw Object.assign(err, {status: 502}); };
  await post(service, {kind: 'test', title: 'Channel Studio is connected', rich: {severity: 'ok', heading: '✓ Channel Studio is connected', summary: 'Ranking and channel alerts will appear here. A sample alert follows.', lines: [], more: 0, footer: 'Test message'}}).catch(fail);
  // A sample of what a real ranking alert looks like.
  await post(service, {kind: 'test', title: 'Sample: Lost #1', rich: {severity: 'high', heading: 'Lost #1 · Laptop › Under ₹50K', summary: '',
    lines: [{rank: '#3', text: 'best laptop under 50000', note: 'taken by Sample Channel', url: 'https://www.youtube.com/'},
            {rank: '#2', text: 'laptop under 50k', note: 'taken by Sample Channel', url: 'https://www.youtube.com/'}],
    more: 0, footer: 'Sample alert · not real data'}}).catch(fail);
}

// ---------- digest (a summary instead of one message per event) ----------
const readKey = (k, d) => { const r = db.prepare(`SELECT value FROM settings WHERE key=?`).get(k); return r ? JSON.parse(r.value) : d; };
const writeKey = (k, v) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, JSON.stringify(v));
export const digestSettings = () => readKey('digest', {mode: 'off', hour: 9, last: null});
export function saveDigest({mode, hour}) {
  const cur = digestSettings();
  if (mode !== undefined && !['off', 'daily', 'weekly'].includes(mode)) throw Object.assign(new Error('Unknown digest mode.'), {status: 400});
  writeKey('digest', {...cur, ...(mode !== undefined && {mode}), ...(hour !== undefined && {hour: Math.max(0, Math.min(23, Number(hour) | 0))})});
}
export const markDigestSent = () => writeKey('digest', {...digestSettings(), last: new Date().toISOString()});
// Sends to every connected, enabled webhook. Returns how many accepted it.
export async function broadcast(message) {
  const targets = Object.keys(SERVICES).filter(s => { const c = read(s); return c.url && c.enabled; });
  if (!targets.length) throw Object.assign(new Error('Connect Discord or Slack first.'), {status: 400});
  const res = await Promise.allSettled(targets.map(s => post(s, message)));
  const ok = res.filter(r => r.status === 'fulfilled').length;
  if (!ok) throw Object.assign(new Error(res[0].reason?.message || 'Delivery failed.'), {status: 502});
  return ok;
}
