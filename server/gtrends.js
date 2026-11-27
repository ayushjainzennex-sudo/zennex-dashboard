// Google Trends reader, shared by the nodes (/api/trends/*) and the Vercel fallback (api/trends.js).
// Uses the same internal endpoints as trends.google.com (no API key), so numbers are Google's relative 0–100 scale.
//  - explore(): interest over time, interest by subregion, related topics and queries for up to 5 terms
//  - trending(): "Trending now" from Google's public RSS feed
// Google rate-limits hard (HTTP 429), so answers are kept in memory for a few minutes.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const BASE = 'https://trends.google.com/trends/api';
let cookie = '', cookieAt = 0;
const cache = new Map();
const remember = (key, ms, data) => { cache.set(key, {at: Date.now(), ms, data}); if (cache.size > 200) cache.delete(cache.keys().next().value); return data; };
const recall = key => { const h = cache.get(key); return h && Date.now() - h.at < h.ms ? h.data : null; };

const json = text => JSON.parse(text.slice(text.indexOf('{')));   // strips Google's ")]}'," prefix
async function get(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, {headers: {'user-agent': UA, 'accept-language': 'en-US', cookie}, signal: AbortSignal.timeout(8000)});
    if (r.status === 429) { if (i < 2) await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
    if (!r.ok) throw Object.assign(new Error(`Google Trends answered ${r.status}`), {status: 502});
    return r.text();
  }
  throw Object.assign(new Error('Google Trends is limiting requests right now. Try again in a few minutes.'), {status: 429});
}

export const TIMES = ['now 1-H', 'now 4-H', 'now 1-d', 'now 7-d', 'today 1-m', 'today 3-m', 'today 12-m', 'today 5-y'];

export async function explore({q = '', geo = 'IN', prop = 'web', time = 'now 1-d'} = {}) {
  const keywords = [...new Set(String(q).split(',').map(k => k.trim().slice(0, 100)).filter(Boolean))].slice(0, 5);
  if (!keywords.length) throw Object.assign(new Error('Enter a search term.'), {status: 400});
  geo = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(geo) ? geo : '';
  prop = prop === 'youtube' ? 'youtube' : 'web';
  if (!TIMES.includes(time)) time = 'now 1-d';
  const key = JSON.stringify(['x', keywords, geo, prop, time]);
  const hit = recall(key); if (hit) return hit;

  if (Date.now() - cookieAt > 30 * 60e3) {   // a visit to the site hands out the NID cookie the API wants
    const home = await fetch('https://trends.google.com/trends/?geo=' + geo, {headers: {'user-agent': UA}, signal: AbortSignal.timeout(8000)});
    cookie = (home.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; '); cookieAt = Date.now();
  }
  const req = {comparisonItem: keywords.map(k => ({keyword: k, geo, time})), category: 0, property: prop === 'web' ? '' : prop};
  const ex = json(await get(`${BASE}/explore?hl=en-US&tz=-330&req=${encodeURIComponent(JSON.stringify(req))}`));
  const widget = id => ex.widgets.find(w => w.id === id) ?? ex.widgets.find(w => w.id.startsWith(id));
  const data = async w => json(await get(`${BASE}/widgetdata/${w.endpoint}?hl=en-US&tz=-330&req=${encodeURIComponent(JSON.stringify(w.w.request))}&token=${w.w.token}`));
  const ts = widget('TIMESERIES'), gw = widget('GEO_MAP'), qw = widget('RELATED_QUERIES'), tw = widget('RELATED_TOPICS');

  // the four requests at once; subregions and related lists are optional (rare terms have none)
  const [series, geoData, queries, topics] = await Promise.all([
    data({w: ts, endpoint: 'multiline'}),
    gw ? data({w: gw, endpoint: 'comparedgeo'}).catch(() => null) : null,
    qw ? data({w: qw, endpoint: 'relatedsearches'}).catch(() => null) : null,
    tw ? data({w: tw, endpoint: 'relatedsearches'}).catch(() => null) : null,
  ]);
  const ranked = (d, f) => (d?.default.rankedList ?? []).map(l => l.rankedKeyword.map(f));
  const [top = [], rising = []] = ranked(queries, k => ({query: k.query, value: k.formattedValue}));
  const [topicsTop = [], topicsRising = []] = ranked(topics, k => ({query: k.topic?.title ?? '', type: k.topic?.type ?? '', value: k.formattedValue}));
  const points = series.default.timelineData.map(p => ({t: Number(p.time) * 1000, values: p.value, partial: !!p.isPartial}));
  const averages = series.default.averages?.length ? series.default.averages : keywords.map((_, i) => points.length ? points.reduce((a, p) => a + p.values[i], 0) / points.length : 0);
  const regions = (geoData?.default.geoMapData ?? []).filter(r => r.value.some(v => v > 0)).map(r => ({name: r.geoName, code: r.geoCode, values: r.value}));
  return remember(key, 10 * 60e3, {keywords, geo, prop, time, fetched: new Date().toISOString(), points, averages, regions, top, rising, topicsTop, topicsRising});
}

// ---------- Trending now ----------
// The full list (hundreds of trends, with categories, volume, % increase, start/end and related terms) is embedded
// in the trends.google.com/trending page itself (AF_initDataCallback 'ds:0'). Pictures and news only come in the
// RSS feed (top ~10), so those are merged in by title. If the page can't be read, the RSS feed alone is used.
export const CATEGORIES = {1: 'Autos & vehicles', 2: 'Beauty & fashion', 3: 'Business & finance', 20: 'Climate', 4: 'Entertainment', 5: 'Food & drink', 6: 'Games',
  7: 'Health', 8: 'Hobbies & leisure', 9: 'Jobs & education', 10: 'Law & government', 11: 'Other', 13: 'Pets & animals', 14: 'Politics', 15: 'Science',
  16: 'Shopping', 17: 'Sports', 18: 'Technology', 19: 'Travel & transportation'};
const unx = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").trim();
const tag = (x, t) => { const m = x.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>')); return m ? unx(m[1]) : ''; };
const traffic = t => (parseInt(t.replace(/\D/g, '')) || 0) * (/K/i.test(t) ? 1e3 : /M/i.test(t) ? 1e6 : 1);

async function rss(geo) {
  const r = await fetch('https://trends.google.com/trending/rss?geo=' + geo, {headers: {'user-agent': UA}, signal: AbortSignal.timeout(8000)});
  if (!r.ok) throw Object.assign(new Error('Google Trends answered ' + r.status), {status: r.status === 429 ? 429 : 502});
  return [...(await r.text()).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, x]) => ({
    title: tag(x, 'title'), volume: traffic(tag(x, 'ht:approx_traffic')), started: Date.parse(tag(x, 'pubDate')) || null,
    picture: tag(x, 'ht:picture'), source: tag(x, 'ht:picture_source'),
    news: [...x.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)].map(([, n]) => ({title: tag(n, 'ht:news_item_title'), url: tag(n, 'ht:news_item_url'), source: tag(n, 'ht:news_item_source')})),
  }));
}
async function page(geo) {
  const r = await fetch(`https://trends.google.com/trending?geo=${geo}&hl=en-US&hours=24`, {headers: {'user-agent': UA, 'accept-language': 'en-US'}, signal: AbortSignal.timeout(9000)});
  if (!r.ok) throw new Error('Google Trends answered ' + r.status);
  const m = (await r.text()).match(/AF_initDataCallback\(\{key: 'ds:0'[\s\S]*?data:([\s\S]*?), sideChannel/);
  const list = m && JSON.parse(m[1])?.[1];
  if (!Array.isArray(list)) throw new Error('Trending page format changed');
  return list.map(x => ({
    title: x[0], started: x[3]?.[0] ? x[3][0] * 1000 : null, ended: x[4]?.[0] ? x[4][0] * 1000 : null,
    volume: x[6] ?? 0, increase: x[8] ?? null, terms: (x[9] ?? []).filter(t => t !== x[0]), categories: x[10] ?? [],
  }));
}

export async function trending({geo = 'IN'} = {}) {
  geo = /^[A-Z]{2}$/.test(geo) ? geo : 'IN';
  const hit = recall('t' + geo); if (hit) return hit;
  const [full, feed] = await Promise.allSettled([page(geo), rss(geo)]);
  if (full.status === 'rejected' && feed.status === 'rejected') throw feed.reason;
  const extra = new Map((feed.value ?? []).map(i => [i.title.toLowerCase(), i]));
  const items = (full.value ?? feed.value).map(i => {
    const e = extra.get(i.title.toLowerCase());
    return {terms: [], categories: [], increase: null, ended: null, ...i, picture: e?.picture ?? '', source: e?.source ?? '', news: e?.news ?? []};
  }).sort((a, b) => b.volume - a.volume || b.started - a.started);
  return remember('t' + geo, 5 * 60e3, {geo, fetched: new Date().toISOString(), full: full.status === 'fulfilled', categories: CATEGORIES, items});
}
