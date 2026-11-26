// Creators added only for the Thumbnails page. They aren't tracked channels (no stats, alerts or rankings):
// just their latest long videos and Shorts, read from their channel tabs and kept for 6 hours.
// Stored in settings as thumbs.creators = [{channelId, path, name, avatar, color, at, uploads}].
import {remoteAll, remoteRun} from './db.js';
import {loadChannel, loadUploads, channelPath} from './youtube.js';
import {HttpError} from './router.js';

const KEY = 'thumbs.creators', FRESH = 6 * 3600e3;
const COLORS = ['#a78bfa', '#f472b6', '#22d3ee', '#fb923c', '#a3e635', '#facc15', '#60a5fa', '#f87171'];
const read = async () => { const v = (await remoteAll(`SELECT value FROM settings WHERE key=?`, [KEY]))[0]?.value; try { return v ? JSON.parse(v) : []; } catch { return []; } };
const write = list => remoteRun(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [KEY, JSON.stringify(list)]);

async function fetchUploads(path) {
  const {videos, shorts} = await loadUploads(path, 2), now = Date.now();
  const gap = 2 * 86400e3;   // Shorts carry no date: space them a couple of days apart, newest first
  return [
    ...videos.filter(v => v.ageMs != null).map(v => ({id: v.id, title: v.title, short: false, views: v.views, published: new Date(now - v.ageMs).toISOString()})),
    ...shorts.map((s, i) => ({id: s.id, title: s.title, short: true, views: s.views, published: new Date(now - (i + 1) * gap).toISOString(), approx: true}))
  ];
}

// The list with uploads, refreshing any creator older than 6 hours.
export async function thumbCreators() {
  const list = await read();
  let changed = false;
  await Promise.all(list.map(async c => {
    if (Date.now() - Date.parse(c.at ?? 0) < FRESH) return;
    try { c.uploads = await fetchUploads(c.path); c.at = new Date().toISOString(); changed = true; } catch {}
  }));
  if (changed) await write(list);
  return list;
}

export async function addThumbCreator(input) {
  const path = typeof input === 'string' ? channelPath(input.slice(0, 300)) : null;
  if (!path) throw new HttpError(400, 'Enter a channel handle like @mkbhd or a YouTube channel link.');
  const info = await loadChannel(path).catch(err => { throw new HttpError(404, err.message); });
  const list = await read();
  if (list.some(c => c.channelId === info.channelId)) throw new HttpError(409, info.title + ' is already on the Thumbnails page.');
  const c = {channelId: info.channelId, path: info.handle ?? path, name: info.title, avatar: info.avatar,
    color: COLORS[list.length % COLORS.length], at: new Date().toISOString(), uploads: await fetchUploads(info.handle ?? path)};
  await write([...list, c]);
  return c;
}

export async function removeThumbCreator(channelId) {
  await write((await read()).filter(c => c.channelId !== channelId));
  return {ok: true};
}

// The page's filters (creators picked, sort, format, period), saved so they're the same after a refresh and on
// every device.
const PREFS = 'thumbs.prefs';
export async function thumbPrefs() {
  const v = (await remoteAll(`SELECT value FROM settings WHERE key=?`, [PREFS]))[0]?.value;
  try { return v ? JSON.parse(v) : {}; } catch { return {}; }
}
export async function saveThumbPrefs(p) {
  const clean = {};
  if (p?.picked === null || Array.isArray(p?.picked)) clean.picked = p.picked?.slice(0, 500).map(x => typeof x === 'number' ? x : String(x).slice(0, 40)) ?? null;
  for (const k of ['sort', 'format', 'period']) if (typeof p?.[k] === 'string') clean[k] = p[k].slice(0, 12);
  const next = {...await thumbPrefs(), ...clean};
  await remoteRun(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [PREFS, JSON.stringify(next)]);
  return next;
}
