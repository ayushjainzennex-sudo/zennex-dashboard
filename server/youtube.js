// Reads public YouTube data: a channel's About page and its uploads RSS feed.
const headers = {
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  cookie: 'CONSENT=YES+1'
};
const decode = text => (text ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const unescapeJson = text => { try { return JSON.parse('"' + text + '"'); } catch { return text; } };
const count = text => {
  const m = /([\d.,]+)\s*([KMB])?/i.exec(text ?? '');
  if (!m) return null;
  return Math.round(Number(m[1].replace(/,/g, '')) * ({K: 1e3, M: 1e6, B: 1e9}[m[2]?.toUpperCase()] ?? 1));
};

// Accepts "@handle", a youtube.com/@handle or /channel/UC… URL, or a bare UC… id. Returns "@handle" or "channel/UC…".
export function channelPath(input) {
  const value = String(input ?? '').trim();
  const handle = /(?:^|youtube\.com\/)(@[\w.-]{3,100})/i.exec(value)?.[1];
  if (handle) return handle;
  const id = /(?:^|channel\/)(UC[\w-]{22})(?:$|[/?#])/.exec(value)?.[1];
  return id ? 'channel/' + id : null;
}

export async function loadFeed(channelId) {
  const response = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId, {headers, signal: AbortSignal.timeout(15000)});
  if (!response.ok) return [];
  const xml = await response.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
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

export async function loadChannel(path) {
  const response = await fetch('https://www.youtube.com/' + path + '/about', {headers, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(response.status === 404 ? 'Channel not found.' : 'YouTube returned ' + response.status + '.');
  const html = await response.text();
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
    videoCount: count(videosText),
    recent: channelId ? await loadFeed(channelId).catch(() => []) : []
  };
}

// Older uploads from the channel's Videos and Shorts tabs (about 30 each). Views are rounded and
// long-form dates are relative ("3 weeks ago"); Shorts have no date at all, so callers estimate it.
const AGE = {s: 1, sec: 1, second: 1, m: 60, min: 60, minute: 60, h: 3600, hour: 3600, d: 86400, day: 86400, w: 604800, week: 604800, mo: 2629800, month: 2629800, y: 31557600, year: 31557600};
export function parseAge(text) {
  const m = /(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|sec|min|mo|[smhdwy])\b/i.exec(text ?? '');
  if (!m) return null;
  const unit = m[2].toLowerCase().replace(/s$/, '');
  return Number(m[1]) * (AGE[unit] ?? AGE[m[2].toLowerCase()] ?? 0) * 1000;
}
async function initialData(path, tab) {
  const response = await fetch('https://www.youtube.com/' + path + '/' + tab, {headers, signal: AbortSignal.timeout(15000)});
  if (!response.ok) return null;
  const json = /var ytInitialData = (\{.*?\});<\/script>/s.exec(await response.text())?.[1];
  return json ? JSON.parse(json) : null;
}
export async function loadUploads(path) {
  const collect = (data, key) => { const out = []; JSON.stringify(data ?? {}, (k, v) => { if (k === key) out.push(v); return v; }); return out; };
  const [videosPage, shortsPage] = await Promise.all([initialData(path, 'videos'), initialData(path, 'shorts')]);
  const videos = collect(videosPage, 'lockupViewModel').map(v => {
    const parts = v.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap(r => r.metadataParts ?? []) ?? [];
    const views = parts.find(p => /view/i.test(p.accessibilityLabel ?? p.text?.content ?? ''));
    const age = parts.map(p => parseAge(p.accessibilityLabel ?? p.text?.content)).find(a => a != null && !/view/i.test(''));
    return {id: v.contentId, title: v.metadata?.lockupMetadataViewModel?.title?.content, short: false,
      views: count(views?.text?.content), ageMs: parts.length > 1 ? parseAge(parts.at(-1).accessibilityLabel ?? parts.at(-1).text?.content) : age};
  }).filter(v => /^[\w-]{11}$/.test(v.id ?? ''));
  const shorts = collect(shortsPage, 'shortsLockupViewModel').map(v => ({
    id: v.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId, title: v.overlayMetadata?.primaryText?.content, short: true,
    views: count(v.overlayMetadata?.secondaryText?.content)
  })).filter(v => /^[\w-]{11}$/.test(v.id ?? ''));
  return {videos, shorts};
}

// Ranked video results for a search query, as seen from India (gl=IN) with YouTube's default sort.
// Positions count regular video results only; Shorts shelves, ads and channel cards are skipped.
export async function searchVideos(query) {
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&gl=IN&hl=en';
  const response = await fetch(url, {headers: {...headers, 'accept-language': 'en-IN,en;q=0.9'}, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('YouTube search returned ' + response.status + '.');
  const json = /var ytInitialData = (\{.*?\});<\/script>/s.exec(await response.text())?.[1];
  if (!json) throw new Error('Search results were not found on the page.');
  const sections = JSON.parse(json).contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
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

// YouTube channel search (the "Channels" filter), as seen from India.
export async function searchChannels(query) {
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAg%253D%253D&gl=IN&hl=en';
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('YouTube search returned ' + response.status + '.');
  const json = /var ytInitialData = (\{.*?\});<\/script>/s.exec(await response.text())?.[1];
  if (!json) throw new Error('Search results were not found on the page.');
  const out = [];
  JSON.stringify(JSON.parse(json), (k, v) => {
    if (k === 'channelRenderer' && v?.channelId) {
      const texts = [v.subscriberCountText?.simpleText, v.videoCountText?.simpleText].filter(Boolean);
      const handle = texts.find(t => t.startsWith('@')) ?? v.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl?.replace(/^\//, '') ?? null;
      const subs = texts.find(t => /subscriber/i.test(t));
      const thumb = v.thumbnail?.thumbnails?.at(-1)?.url;
      out.push({channelId: v.channelId, title: v.title?.simpleText ?? '', handle: handle?.startsWith('@') ? handle : null,
        subscribers: subs ? count(subs) : null, avatar: thumb ? (thumb.startsWith('//') ? 'https:' + thumb : thumb) : null});
    }
    return v;
  });
  return out.slice(0, 8);
}

// Search inside one channel (its own search box on YouTube). Returns exact view counts and relative ages.
export async function searchChannelVideos(path, query) {
  const url = 'https://www.youtube.com/' + path + '/search?query=' + encodeURIComponent(query) + '&hl=en&gl=IN';
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('YouTube returned ' + response.status + '.');
  const json = /var ytInitialData = (\{.*?\});<\/script>/s.exec(await response.text())?.[1];
  if (!json) throw new Error('Search results were not found on the page.');
  const out = [], seen = new Set();
  const secs = t => (t ?? '').split(':').reduce((a, n) => a * 60 + Number(n), 0) || null;
  JSON.stringify(JSON.parse(json), (k, v) => {
    if (k === 'videoRenderer' && v?.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      const seconds = secs(v.lengthText?.simpleText);
      const short = /\/shorts\//.test(v.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ?? '') || (seconds != null && seconds <= 180);
      out.push({id: v.videoId, title: v.title?.runs?.map(r => r.text).join('') ?? '', views: count(v.viewCountText?.simpleText),
        age: v.publishedTimeText?.simpleText ?? null, ageMs: parseAge(v.publishedTimeText?.simpleText), seconds, short});
    }
    return v;
  });
  return out;
}
