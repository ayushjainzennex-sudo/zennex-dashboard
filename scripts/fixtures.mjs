// Saves fresh copies of the YouTube pages the dashboard reads into test/fixtures (gzipped), for the parser tests.
// Run it when YouTube changes a page and the tests (or the "Can't read YouTube ..." alert) say a parser broke:
//   npm run fixtures            then   npm test
// Optional: npm run fixtures -- @someChannel "some search"
import {writeFileSync, mkdirSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import * as yt from '../server/youtube.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const [channel = '@techum', query = 'best laptop under 50000'] = process.argv.slice(2);
const headers = {
  'accept-language': 'en-IN,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  cookie: 'CONSENT=YES+1'
};
const get = async url => {
  const r = await fetch(url, {headers, signal: AbortSignal.timeout(20000)});
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.text();
};

mkdirSync(dir, {recursive: true});
// YouTube sometimes serves a stripped page; fetch again until the parser can read it (up to 4 tries).
const PARSERS = {search: yt.parseSearch, 'channel-search': yt.parseChannelResults, 'in-channel-search': yt.parseChannelVideos, videos: yt.parseVideosTab, shorts: yt.parseShortsTab};
const getGood = async (name, url) => {
  for (let i = 1; ; i++) {
    const text = await get(url);
    try { PARSERS[name]?.(text); return text; }
    catch (err) { if (i >= 4) throw err; console.warn(name, ': unreadable page (' + err.message + '), retrying'); await new Promise(r => setTimeout(r, 3000)); }
  }
};
const about = await get(`https://www.youtube.com/${channel}/about`);
const channelId = /"channelId":"(UC[\w-]{22})"/.exec(about)?.[1];
if (!channelId) throw new Error('No channel id on the About page.');
const pages = {
  about,
  feed: await get('https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId),
  videos: await getGood('videos', `https://www.youtube.com/${channel}/videos`),
  shorts: await getGood('shorts', `https://www.youtube.com/${channel}/shorts`),
  search: await getGood('search', 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&gl=IN&hl=en'),
  'channel-search': await getGood('channel-search', 'https://www.youtube.com/results?search_query=' + encodeURIComponent(channel.replace('@', '')) + '&sp=EgIQAg%253D%253D&gl=IN&hl=en'),
  'in-channel-search': await getGood('in-channel-search', `https://www.youtube.com/${channel}/search?query=laptop&hl=en&gl=IN`)
};
// Pages are slimmed to what the parsers read (the og: meta tags and the ytInitialData block), but only when
// the slim copy parses exactly like the full page; otherwise the full page is kept.
const PARSE = {about: yt.parseAbout, feed: yt.parseFeed, videos: yt.parseVideosTab, shorts: yt.parseShortsTab, search: yt.parseSearch,
  'channel-search': yt.parseChannelResults, 'in-channel-search': yt.parseChannelVideos};
const slim = html => {
  const meta = html.match(/<meta property="og:[^>]*>/g) ?? [];
  const data = /var ytInitialData = \{.*?\};<\/script>/s.exec(html)?.[0];
  return data ? '<html><head>' + meta.join('') + '</head><body><script>' + data + '</body></html>' : html;
};
for (const [name, full] of Object.entries(pages)) {
  const small = name === 'feed' ? full : slim(full);
  const same = isDeepStrictEqual(PARSE[name](small), PARSE[name](full));
  const text = same ? small : full;
  if (!same) console.warn(name, ': slim copy parses differently, keeping the full page');
  const gz = gzipSync(text, {level: 9});
  writeFileSync(join(dir, name + '.gz'), gz);
  console.log(name.padEnd(18), (text.length / 1024).toFixed(0).padStart(5), 'KB ->', (gz.length / 1024).toFixed(0).padStart(4), 'KB');
}
writeFileSync(join(dir, 'meta.json'), JSON.stringify({channel, channelId, query, saved: new Date().toISOString()}, null, 2) + '\n');
