// Topic research (pure: no database, so the Vercel fallback can use it too; see api/research.js).
//  - suggest(seed): YouTube autocomplete for the seed, plus A–Z and question expansions (long-tail ideas)
//  - ideas(seed): autocomplete + Google Trends related queries (YouTube Search, 12 months) + Trending now matches
//  - score(q): a 0–100 scorecard from YouTube search results and Google Trends, with its parts shown
// The database parts (competitor videos on the topic) are added by server/research-db.js on nodes.
// Part of the topic-research feature: see RESEARCH.md for how to remove it.
import {searchVideos, parseAge} from './youtube.js';
import {explore, trending} from './gtrends.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const cache = new Map();
const cached = async (key, ms, fn) => {
  const h = cache.get(key); if (h && Date.now() - h.at < ms) return h.data;
  const data = await fn(); cache.set(key, {at: Date.now(), data});
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
};
export const clean = q => String(q ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
export const tokens = q => clean(q).split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3 || /^\d+$/.test(t));

// ---------- autocomplete ----------
async function complete(q, gl) {
  const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en-IN&gl=${gl}&q=${encodeURIComponent(q)}`, {headers: {'user-agent': UA}, signal: AbortSignal.timeout(6000)});
  if (!r.ok) return [];
  const d = await r.json().catch(() => null);
  return Array.isArray(d?.[1]) ? d[1].map(clean) : [];
}
// YouTube still mixes in suggestions for other countries ("… in pakistan", "… price in dubai"); research is for India,
// so those are dropped. Indian languages and states (tamil, telugu, kerala…) are kept.
const FOREIGN = new RegExp('\\b(' + ['pakistan', 'pak', 'pakistani', 'bangladesh', 'bd', 'nepal', 'nepali', 'sri ?lanka', 'lanka', 'dubai', 'uae', 'saudi', 'ksa', 'qatar', 'oman', 'kuwait', 'bahrain',
  'usa', 'us', 'america', 'uk', 'canada', 'australia', 'philippines', 'nigeria', 'kenya', 'malaysia', 'indonesia', 'singapore', 'egypt', 'europe', 'germany', 'japan', 'china',
  'pkr', 'taka', 'bdt', 'npr', 'aed', 'dirham', 'dollars?', 'usd', 'riyal', 'urdu', 'bangla'].join('|') + ')\\b|\\$', 'i');
export const suggest = (seed, geo = 'IN') => cached('s' + geo + seed, 6 * 36e5, async () => {
  const gl = (geo || 'IN').toLowerCase();
  const probes = [seed, ...'abcdefghijklmnopqrstuvwxyz'.split('').map(c => seed + ' ' + c),
    ...['best', 'how to', 'why', 'is', 'which'].map(w => w + ' ' + seed), seed + ' vs', seed + ' for'];
  const out = new Map();   // phrase -> rank (earlier probe and position = more common)
  for (let i = 0; i < probes.length; i += 8) {   // a few at a time, to stay polite
    const lists = await Promise.all(probes.slice(i, i + 8).map(p => complete(p, gl).catch(() => [])));
    lists.forEach((l, j) => l.forEach((s, k) => { if (s !== seed && !out.has(s)) out.set(s, (i + j) * 10 + k); }));
  }
  return [...out].sort((a, b) => a[1] - b[1]).map(([s]) => s).filter(s => !FOREIGN.test(s));
});

// ---------- ideas ----------
export async function ideas(seed, geo = 'IN') {
  seed = clean(seed);
  if (!seed) throw Object.assign(new Error('Enter a topic.'), {status: 400});
  const words = tokens(seed);
  const [ac, tr, now] = await Promise.allSettled([
    suggest(seed, geo),
    explore({q: seed, geo, prop: 'youtube', time: 'today 12-m'}),
    trending({geo: geo || 'IN'}),
  ]);
  const list = new Map();
  const add = (query, source, extra = {}) => {
    query = clean(query); if (!query || query === seed) return;
    const it = list.get(query) ?? {query, sources: [], rising: null, trendVolume: null};
    if (!it.sources.includes(source)) it.sources.push(source);
    Object.assign(it, extra); list.set(query, it);
  };
  for (const s of ac.value ?? []) add(s, 'autocomplete');
  for (const r of tr.value?.rising ?? []) add(r.query, 'trends-rising', {rising: r.value});
  for (const r of tr.value?.top ?? []) add(r.query, 'trends-top');
  // A trending search counts only if it contains most of the topic's real words (whole words). Place names, years
  // and filler ("india", "price", "best", "2026") are ignored, so "laptop price india" doesn't pull in cricket.
  const GENERIC = new Set(['india', 'indian', 'price', 'prices', 'best', 'under', 'top', 'new', 'latest', 'review', 'vs', 'buy', 'cheap', 'sale', 'online', 'for', 'with', 'the', 'and', 'how', 'what', 'which', 'why', 'news', 'today', 'live']);
  const core = words.filter(w => !/^\d+$/.test(w) && !GENERIC.has(w));
  const hit = text => {
    if (!core.length) return false;
    const t = new Set(tokens(text));
    const n = core.filter(w => t.has(w) || t.has(w + 's') || (w.endsWith('s') && t.has(w.slice(0, -1)))).length;
    return n >= Math.max(1, Math.ceil(core.length * .6));
  };
  for (const i of now.value?.items ?? []) if (hit(i.title + ' ' + i.terms.join(' '))) add(i.title, 'trending-now', {trendVolume: i.volume, increase: i.increase});
  return {seed, geo, fetched: new Date().toISOString(), ideas: [...list.values()],
    errors: Object.fromEntries([['autocomplete', ac], ['trends', tr], ['trending', now]].filter(([, r]) => r.status === 'rejected').map(([k, r]) => [k, r.reason.message]))};
}

// ---------- scorecard ----------
const clamp = v => Math.max(0, Math.min(100, Math.round(v)));
const median = l => { if (!l.length) return null; const a = [...l].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const MONTH = 30.4 * 864e5;

export const score = (q, geo = 'IN') => cached('c' + geo + clean(q), 6 * 36e5, async () => {
  q = clean(q);
  if (!q) throw Object.assign(new Error('Enter a topic.'), {status: 400});
  // YouTube now and then serves a stripped results page: try the search once more before giving up.
  const search = () => searchVideos(q).catch(async () => { await new Promise(r => setTimeout(r, 1500)); return searchVideos(q); });
  const [sr, tr] = await Promise.allSettled([search(), explore({q, geo, prop: 'youtube', time: 'today 12-m'})]);
  if (sr.status === 'rejected') throw Object.assign(new Error('Could not read YouTube search: ' + sr.reason.message), {status: 502});
  const now = Date.now();
  const results = sr.value.slice(0, 20).map((v, i) => {
    const ageMs = parseAge(v.age);
    return {...v, rank: i + 1, ageMs, published: ageMs != null ? new Date(now - ageMs).toISOString() : null};
  });
  const views = results.map(v => v.views).filter(v => v != null);
  const med = median(views) ?? 0;
  const top10 = results.slice(0, 10).filter(v => v.ageMs != null);
  const old = top10.filter(v => v.ageMs > 12 * MONTH).length;
  const recent = results.filter(v => v.ageMs != null && v.ageMs < 6 * MONTH);
  const winners = recent.filter(v => v.views >= med);
  const channels = new Set(results.map(v => v.channel)).size;

  // Demand: how many views the videos people find for this search get (1K → 0, 1M+ → 100, log scale).
  const demand = clamp((Math.log10(Math.max(1, med)) - 3) / 3 * 100);
  // Momentum: Google Trends interest (YouTube Search) in the last 3 months vs the 9 before. Unknown → 50.
  let momentum = 50, change = null, series = [], peak = null;
  const pts = tr.value?.points ?? [];
  if (pts.length > 12 && pts.some(p => p.values[0] > 0)) {
    series = pts.map(p => ({t: p.t, v: p.values[0]}));
    const last = series.slice(-13), before = series.slice(0, -13);
    const avg = l => l.reduce((a, p) => a + p.v, 0) / Math.max(1, l.length);
    const b = avg(before); change = b ? (avg(last) - b) / b * 100 : null;
    momentum = change == null ? 60 : clamp(50 + change);
    const pk = series.reduce((a, p) => p.v > a.v ? p : a);
    peak = new Date(pk.t).toLocaleString('en-IN', {month: 'long'});
  }
  // Freshness gap: how much of the top 10 is over a year old (room for a newer video).
  const freshness = top10.length ? clamp(old / top10.length * 100) : 50;
  // Opening: recent videos (under 6 months) that already beat the median of the results. New videos can still win.
  const opening = clamp(winners.length / 4 * 100);
  // Spread: many different channels in the results means no single channel owns the topic.
  const spread = clamp((channels - 4) / 10 * 100);

  const parts = [
    {key: 'demand', label: 'Demand', value: demand, weight: .3, note: `Typical top result has ${fmtN(med)} views`},
    {key: 'momentum', label: 'Momentum', value: momentum, weight: .2, note: change == null ? 'Not enough Google Trends data' : `${change >= 0 ? '+' : ''}${Math.round(change)}% interest, last 3 months vs before${peak ? ' · peaks in ' + peak : ''}`},
    {key: 'freshness', label: 'Freshness gap', value: freshness, weight: .2, note: `${old} of the top ${top10.length} are over a year old`},
    {key: 'opening', label: 'Opening for new videos', value: opening, weight: .2, note: `${winners.length} video${winners.length === 1 ? '' : 's'} under 6 months old beat the median`},
    {key: 'spread', label: 'Not dominated', value: spread, weight: .1, note: `${channels} different channels in the top ${results.length}`},
  ];
  const total = clamp(parts.reduce((a, p) => a + p.value * p.weight, 0));
  return {q, geo, fetched: new Date().toISOString(), total, verdict: total >= 70 ? 'Strong' : total >= 50 ? 'Worth a look' : total >= 35 ? 'Crowded or quiet' : 'Weak',
    parts, results, series, related: {rising: tr.value?.rising ?? [], top: tr.value?.top ?? []}, trendsError: tr.status === 'rejected' ? tr.reason.message : null};
});
const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n));

// ---------- compare (step 3) ----------
// 2–5 topics: one Google Trends chart on a shared scale (YouTube Search, 12 months) plus each topic's scorecard.
export async function compare(list, geo = 'IN') {
  const qs = [...new Set((Array.isArray(list) ? list : String(list ?? '').split(',')).map(clean).filter(Boolean))].slice(0, 5);
  if (qs.length < 2) throw Object.assign(new Error('Pick at least 2 topics to compare.'), {status: 400});
  const [tr, ...cards] = await Promise.allSettled([explore({q: qs.join(','), geo, prop: 'youtube', time: 'today 12-m'}), ...qs.map(q => score(q, geo))]);
  return {geo, fetched: new Date().toISOString(), topics: qs,
    trends: tr.status === 'fulfilled' ? {points: tr.value.points, averages: tr.value.averages} : null, trendsError: tr.status === 'rejected' ? tr.reason.message : null,
    cards: cards.map((c, i) => c.status === 'fulfilled' ? {q: qs[i], total: c.value.total, verdict: c.value.verdict, parts: c.value.parts, top: c.value.results.slice(0, 4)} : {q: qs[i], error: c.reason.message})};
}

// ---------- angles & titles (step 4) ----------
const PATTERNS = [
  ['list', 'Best / Top N list', /\b(best|top\s*\d+|\d+\s*best)\b/i],
  ['versus', 'X vs Y', /\bvs\.?\b|\bversus\b/i],
  ['warning', 'Warning / don’t buy', /don'?t buy|before (you )?buy|mistake|avoid|worst|never buy|scam|truth/i],
  ['review', 'Review / tested', /review|tested|test|unboxing|hands[- ]on|long[- ]term|after \d+/i],
  ['howto', 'How-to / guide', /how to|guide|tips|explained|setup|buying guide/i],
  ['question', 'Question', /\?|^(is|should|which|why|what|can)\b/i],
  ['price', 'Price / budget hook', /under\s*[₹\d]|budget|cheap|₹|\brs\.?\s*\d|price/i],
  ['year', 'Mentions the year', /\b20\d\d\b/],
];
const EMOJI = /\p{Extended_Pictographic}/u;
export const angles = (q, geo = 'IN', extra = []) => cached('a' + geo + clean(q), 6 * 36e5, async () => {
  q = clean(q);
  if (!q) throw Object.assign(new Error('Enter a topic.'), {status: 400});
  const [card, sug] = await Promise.allSettled([score(q, geo), suggest(q, geo)]);
  if (card.status === 'rejected') throw card.reason;
  const vids = [...card.value.results.map(v => ({...v, from: 'search'})), ...extra.map(v => ({...v, from: 'competitor'}))].filter(v => v.title);
  const medAll = median(vids.map(v => v.views ?? 0)) || 1;
  const patterns = PATTERNS.map(([key, label, re]) => {
    const m = vids.filter(v => re.test(v.title));
    const med = median(m.map(v => v.views ?? 0));
    return {key, label, count: m.length, share: Math.round(m.length / Math.max(1, vids.length) * 100), lift: m.length >= 3 && med ? med / medAll : null,   // too few videos: no multiplier
      examples: m.sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 3).map(v => ({id: v.id, title: v.title, views: v.views, channel: v.channel ?? v.name}))};
  }).filter(p => p.count).sort((a, b) => (b.lift ?? .5) * b.count - (a.lift ?? .5) * a.count);
  const lens = vids.map(v => [...v.title].length);
  const style = {
    length: median(lens), emoji: Math.round(vids.filter(v => EMOJI.test(v.title)).length / Math.max(1, vids.length) * 100),
    caps: Math.round(vids.filter(v => /\b[A-Z]{4,}\b/.test(v.title)).length / Math.max(1, vids.length) * 100),
    numbers: Math.round(vids.filter(v => /\d/.test(v.title)).length / Math.max(1, vids.length) * 100),
  };
  // Questions and sub-angles people type: good for Shorts or sections.
  const QW = /^(is|are|should|which|why|what|how|can|does|do|when|where)\b|\b(worth it|vs|or|for students|for gaming|for coding|for editing|for office)\b/;
  const questions = (sug.value ?? []).filter(s => QW.test(s)).slice(0, 20);
  const thumbs = card.value.results.slice(0, 8).map(v => ({id: v.id, title: v.title, views: v.views, channel: v.channel}));
  return {q, geo, fetched: new Date().toISOString(), patterns, style, questions, thumbs, sample: vids.length};
});
