// Reads public YouTube data: channel pages, the uploads RSS feed and search results.
// Each reader is split in two: fetching the page, and a parse* function that only reads the HTML/XML.
// The parsers are tested against saved pages (test/fixtures), so a YouTube layout change shows up as a
// failing test. At runtime, readers that keep coming back broken raise an alert (see `health` below).
const headers = {
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  cookie: 'CONSENT=YES+1'
};
const decode = text => (text ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const unescapeJson = text => { try { return JSON.parse('"' + text + '"'); } catch { return text; } };
export const count = text => {
  const m = /([\d.,]+)\s*([KMB])?/i.exec(text ?? '');
  if (!m) return null;
  return Math.round(Number(m[1].replace(/,/g, '')) * ({K: 1e3, M: 1e6, B: 1e9}[m[2]?.toUpperCase()] ?? 1));
};

// ---------- reader health ----------
// A reader is "broken" when YouTube answers with an error or a page the parser can't read. After 3 broken
// reads in a row the onBroken hook fires once (an alert); the next good read fires onFixed.
const BROKEN_AFTER = 3;
const health = new Map(); // reader -> {fails, lastError, lastOk, alerted}
const hooks = {onBroken: null, onFixed: null};
export function onReaderHealth(onBroken, onFixed) { hooks.onBroken = onBroken; hooks.onFixed = onFixed; }
export const readerHealth = () => Object.fromEntries([...health].map(([k, v]) => [k, {fails: v.fails, lastError: v.lastError, lastOk: v.lastOk}]));
function ok(reader) {
  const h = health.get(reader);
  if (h?.alerted) try { hooks.onFixed?.(reader); } catch {}
  health.set(reader, {fails: 0, lastError: null, lastOk: new Date().toISOString(), alerted: false});
}
function broken(reader, err) {
  const h = health.get(reader) ?? {fails: 0, lastOk: null, alerted: false};
  h.fails++; h.lastError = err.message;
  if (h.fails >= BROKEN_AFTER && !h.alerted) { h.alerted = true; try { hooks.onBroken?.(reader, err.message, h.fails); } catch {} }
  health.set(reader, h);
}
// Runs fetch + parse for one reader, keeping its health. Errors marked {notBroken: true} (e.g. "Channel not
// found") don't count: they're about the input, not about YouTube's page.
async function read(reader, fn) {
  try { const out = await fn(); ok(reader); return out; }
  catch (err) { if (!err.notBroken) broken(reader, err); throw err; }
}
const notBroken = message => Object.assign(new Error(message), {notBroken: true});

async function getPage(url, extra = {}, notFound = null) {
  const response = await fetch(url, {headers: {...headers, ...extra}, signal: AbortSignal.timeout(15000)});
  if (response.status === 404 && notFound) throw notBroken(notFound);
  if (!response.ok) throw new Error('YouTube returned ' + response.status + '.');
  return response.text();
}
export function initialData(html) {
  const json = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html ?? '')?.[1];
  return json ? JSON.parse(json) : null;
}
const collect = (data, key) => { const out = []; JSON.stringify(data ?? {}, (k, v) => { if (k === key) out.push(v); return v; }); return out; };

// Accepts "@handle", a youtube.com/@handle or /channel/UC… URL, or a bare UC… id. Returns "@handle" or "channel/UC…".
export function channelPath(input) {
  const value = String(input ?? '').trim();
  const handle = /(?:^|youtube\.com\/)(@[\w.-]{3,100})/i.exec(value)?.[1];
  if (handle) return handle;
  const id = /(?:^|channel\/)(UC[\w-]{22})(?:$|[/?#])/.exec(value)?.[1];
  return id ? 'channel/' + id : null;
}

// ---------- uploads RSS feed (newest ~15, exact dates and views) ----------
export function parseFeed(xml) {
  return [...(xml ?? '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const tag = re => re.exec(e)?.[1];
    return {
      id: tag(/<yt:videoId>([^<]+)/),
      title: decode(tag(/<title>([^<]*)/)),
      short: /\/shorts\//.test(tag(/<link rel="alternate" href="([^"]+)"/) ?? ''),
      published: tag(/<published>([^<]+)/),
      views: Number(tag(/<media:statistics views="(\d+)"/) ?? 0),
      likes: Number(tag(/<media:starRating count="(\d+)"/) ?? 0),
      thumbnail: tag(/<media:thumbnail url="([^"]+)"/)
    };
  });
}
export const loadFeed = channelId => read('feed', async () => {
  const response = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId, {headers, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('The uploads feed returned ' + response.status + '.');
  const xml = await response.text();
  if (!xml.includes('<feed')) throw new Error('The uploads feed was not readable.');
  return parseFeed(xml);
});

// ---------- channel About page (stats) ----------
export function parseAbout(html) {
  const field = key => new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.)*)"').exec(html)?.[1];
  const subscribersText = field('subscriberCountText'), viewsText = field('viewCountText'), videosText = field('videoCountText');
  if (!subscribersText && !viewsText) throw new Error('Channel stats were not found on the page.');
  const channelId = /"channelId":"(UC[\w-]{22})"/.exec(html)?.[1];
  const about = html.slice(html.indexOf('aboutChannelViewModel'));
  return {
    channelId,
    handle: /"canonicalChannelUrl":"https?:\/\/www\.youtube\.com\/(@[^"]+)"/.exec(about)?.[1],
    title: decode(/<meta property="og:title" content="([^"]+)"/.exec(html)?.[1]),
    avatar: /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1],
    country: /"country":"([^"]+)"/.exec(about)?.[1],
    joined: /"joinedDateText":\{"content":"Joined ([^"]+)"/.exec(about)?.[1],
    description: unescapeJson(/"description":"((?:[^"\\]|\\.)*)"/.exec(about)?.[1] ?? '').slice(0, 400),
    subscribers: count(subscribersText),
    totalViews: count(viewsText),
    videoCount: count(videosText)
  };
}
export async function loadChannel(path) {
  const info = await read('channel', async () => parseAbout(await getPage('https://www.youtube.com/' + path + '/about', {}, 'Channel not found.')));
  return {...info, recent: info.channelId ? await loadFeed(info.channelId).catch(() => []) : []};
}

// ---------- Videos and Shorts tabs (about 30 each) ----------
// Views are rounded and long-form dates are relative ("3 weeks ago"); Shorts have no date at all, so callers estimate it.
const AGE = {s: 1, sec: 1, second: 1, m: 60, min: 60, minute: 60, h: 3600, hour: 3600, d: 86400, day: 86400, w: 604800, week: 604800, mo: 2629800, month: 2629800, y: 31557600, year: 31557600};
export function parseAge(text) {
  const m = /(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|sec|min|mo|[smhdwy])\b/i.exec(text ?? '');
  if (!m) return null;
  const unit = m[2].toLowerCase().replace(/s$/, '');
  return Number(m[1]) * (AGE[unit] ?? AGE[m[2].toLowerCase()] ?? 0) * 1000;
}
export function parseVideosTab(html) {
  const data = initialData(html);
  if (!data) throw new Error('The Videos tab was not readable.');
  return collect(data, 'lockupViewModel').map(v => {
    const parts = v.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap(r => r.metadataParts ?? []) ?? [];
    const views = parts.find(p => /view/i.test(p.accessibilityLabel ?? p.text?.content ?? ''));
    const label = p => p.accessibilityLabel ?? p.text?.content;
    return {id: v.contentId, title: v.metadata?.lockupMetadataViewModel?.title?.content, short: false,
      views: count(views?.text?.content), ageMs: parts.length > 1 ? parseAge(label(parts.at(-1))) : parts.map(p => parseAge(label(p))).find(a => a != null)};
  }).filter(v => /^[\w-]{11}$/.test(v.id ?? ''));
}
export function parseShortsTab(html) {
  const data = initialData(html);
  if (!data) throw new Error('The Shorts tab was not readable.');
  return collect(data, 'shortsLockupViewModel').map(v => ({
    id: v.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId, title: v.overlayMetadata?.primaryText?.content, short: true,
    views: count(v.overlayMetadata?.secondaryText?.content)
  })).filter(v => /^[\w-]{11}$/.test(v.id ?? ''));
}
export async function loadUploads(path) {
  const tab = (name, parse) => read(name, async () => parse(await getPage('https://www.youtube.com/' + path + '/' + name, {}, 'Channel not found.')))
    .catch(() => []); // one tab failing shouldn't lose the other
  const [videos, shorts] = await Promise.all([tab('videos', parseVideosTab), tab('shorts', parseShortsTab)]);
  return {videos, shorts};
}

// ---------- search ----------
// Ranked video results for a search query, as seen from India (gl=IN) with YouTube's default sort.
// Positions count regular video results only; Shorts shelves, ads and channel cards are skipped.
export function parseSearch(html) {
  const data = initialData(html);
  if (!data) throw new Error('Search results were not found on the page.');
  const sections = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  const results = [];
  for (const section of sections) for (const item of section.itemSectionRenderer?.contents ?? []) {
    const v = item.videoRenderer;
    if (!v?.videoId) continue;
    const owner = v.ownerText?.runs?.[0];
    results.push({
      id: v.videoId, title: v.title?.runs?.map(r => r.text).join('') ?? '',
      channel: owner?.text ?? '', channelIds: [...new Set(JSON.stringify(v.ownerText ?? {}).match(/UC[\w-]{22}/g) ?? [])],
      views: count(v.viewCountText?.simpleText), age: v.publishedTimeText?.simpleText ?? null
    });
  }
  // YouTube occasionally serves a stripped page; never let that read as "not found".
  if (results.length < 5) throw new Error('YouTube returned an incomplete results page.');
  return results;
}
export const searchVideos = query => read('search', async () =>
  parseSearch(await getPage('https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&gl=IN&hl=en', {'accept-language': 'en-IN,en;q=0.9'})));

// YouTube channel search (the "Channels" filter), as seen from India.
export function parseChannelResults(html) {
  const data = initialData(html);
  if (!data) throw new Error('Search results were not found on the page.');
  return collect(data, 'channelRenderer').filter(v => v?.channelId).map(v => {
    const texts = [v.subscriberCountText?.simpleText, v.videoCountText?.simpleText].filter(Boolean);
    const handle = texts.find(t => t.startsWith('@')) ?? v.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl?.replace(/^\//, '') ?? null;
    const subs = texts.find(t => /subscriber/i.test(t));
    const thumb = v.thumbnail?.thumbnails?.at(-1)?.url;
    return {channelId: v.channelId, title: v.title?.simpleText ?? '', handle: handle?.startsWith('@') ? handle : null,
      subscribers: subs ? count(subs) : null, avatar: thumb ? (thumb.startsWith('//') ? 'https:' + thumb : thumb) : null};
  }).slice(0, 8);
}
export const searchChannels = query => read('channel-search', async () =>
  parseChannelResults(await getPage('https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAg%253D%253D&gl=IN&hl=en')));

// Search inside one channel (its own search box on YouTube). Returns exact view counts and relative ages.
export function parseChannelVideos(html) {
  const data = initialData(html);
  if (!data) throw new Error('Search results were not found on the page.');
  const out = [], seen = new Set();
  const secs = t => (t ?? '').split(':').reduce((a, n) => a * 60 + Number(n), 0) || null;
  for (const v of collect(data, 'videoRenderer')) {
    if (!v?.videoId || seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    const seconds = secs(v.lengthText?.simpleText);
    const short = /\/shorts\//.test(v.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ?? '') || (seconds != null && seconds <= 180);
    out.push({id: v.videoId, title: v.title?.runs?.map(r => r.text).join('') ?? '', views: count(v.viewCountText?.simpleText),
      age: v.publishedTimeText?.simpleText ?? null, ageMs: parseAge(v.publishedTimeText?.simpleText), seconds, short});
  }
  return out;
}
export const searchChannelVideos = (path, query) => read('in-channel-search', async () =>
  parseChannelVideos(await getPage('https://www.youtube.com/' + path + '/search?query=' + encodeURIComponent(query) + '&hl=en&gl=IN')));
