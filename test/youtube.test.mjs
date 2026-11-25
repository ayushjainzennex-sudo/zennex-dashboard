// Parser tests against saved YouTube pages (test/fixtures, refreshed with `npm run fixtures`).
// They check the shape of what's read, not exact numbers, so fresh fixtures pass without editing the tests.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import * as yt from '../server/youtube.js';

const page = name => gunzipSync(readFileSync(new URL('./fixtures/' + name + '.gz', import.meta.url))).toString();
const meta = JSON.parse(readFileSync(new URL('./fixtures/meta.json', import.meta.url)));
const VIDEO_ID = /^[\w-]{11}$/;

test('count() reads YouTube number formats', () => {
  assert.equal(yt.count('369K subscribers'), 369000);
  assert.equal(yt.count('1.2M views'), 1200000);
  assert.equal(yt.count('2,473 videos'), 2473);
  assert.equal(yt.count('3.4B'), 3400000000);
  assert.equal(yt.count('no number'), null);
  assert.equal(yt.count(undefined), null);
});

test('parseAge() reads relative ages', () => {
  assert.equal(yt.parseAge('3 weeks ago'), 3 * 604800e3);
  assert.equal(yt.parseAge('1 day ago'), 86400e3);
  assert.equal(yt.parseAge('5 months ago'), 5 * 2629800e3);
  assert.equal(yt.parseAge('2 hours ago'), 7200e3);
  assert.equal(yt.parseAge('Streamed'), null);
});

test('channelPath() accepts handles, links and ids', () => {
  assert.equal(yt.channelPath('@techum'), '@techum');
  assert.equal(yt.channelPath('https://www.youtube.com/@10tech_official/videos'), '@10tech_official');
  assert.equal(yt.channelPath('https://youtube.com/channel/UC1234567890123456789012'), 'channel/UC1234567890123456789012');
  assert.equal(yt.channelPath('UC1234567890123456789012'), 'channel/UC1234567890123456789012');
  assert.equal(yt.channelPath('not a channel'), null);
});

test('About page: channel stats', () => {
  const c = yt.parseAbout(page('about'));
  assert.equal(c.channelId, meta.channelId);
  assert.match(c.handle ?? '', /^@/);
  assert.ok(c.title, 'title');
  assert.match(c.avatar ?? '', /^https:\/\//);
  assert.ok(c.subscribers > 0, 'subscribers');
  assert.ok(c.totalViews > 0, 'total views');
  assert.ok(c.videoCount > 0, 'video count');
});

test('About page: a page without stats is an error, not zeros', () => {
  assert.throws(() => yt.parseAbout('<html>consent page</html>'), /stats were not found/);
});

test('Uploads feed: recent videos with exact dates', () => {
  const list = yt.parseFeed(page('feed'));
  assert.ok(list.length >= 5, 'at least 5 entries');
  for (const v of list) {
    assert.match(v.id, VIDEO_ID);
    assert.ok(v.title);
    assert.ok(!Number.isNaN(Date.parse(v.published)), 'published date');
    assert.ok(v.views >= 0);
  }
});

test('Videos tab: long videos with views and ages', () => {
  const list = yt.parseVideosTab(page('videos'));
  assert.ok(list.length >= 10, 'at least 10 videos, got ' + list.length);
  for (const v of list) { assert.match(v.id, VIDEO_ID); assert.ok(v.title); assert.equal(v.short, false); }
  assert.ok(list.filter(v => v.views > 0).length >= list.length * 0.8, 'most have views');
  assert.ok(list.filter(v => v.ageMs > 0).length >= list.length * 0.8, 'most have an age');
});

test('Shorts tab: Shorts with views', () => {
  const list = yt.parseShortsTab(page('shorts'));
  assert.ok(list.length >= 5, 'at least 5 Shorts, got ' + list.length);
  for (const v of list) { assert.match(v.id, VIDEO_ID); assert.equal(v.short, true); }
  assert.ok(list.filter(v => v.views > 0).length >= list.length * 0.8, 'most have views');
});

test('Tabs: a page without data is an error', () => {
  assert.throws(() => yt.parseVideosTab('<html></html>'), /not readable/);
  assert.throws(() => yt.parseShortsTab('<html></html>'), /not readable/);
});

test('Search: ranked video results', () => {
  const list = yt.parseSearch(page('search'));
  assert.ok(list.length >= 5);
  for (const v of list) {
    assert.match(v.id, VIDEO_ID);
    assert.ok(v.title);
    assert.ok(v.channel, 'channel name');
    assert.ok(v.channelIds.every(id => /^UC[\w-]{22}$/.test(id)));
  }
  assert.ok(list.filter(v => v.channelIds.length).length >= list.length * 0.8, 'most have a channel id');
  assert.ok(list.filter(v => v.views > 0).length >= list.length * 0.6, 'most have views');
});

test('Search: a stripped page is an error, never "not ranked"', () => {
  assert.throws(() => yt.parseSearch('<html></html>'), /not found on the page/);
  assert.throws(() => yt.parseSearch('<script>var ytInitialData = {"contents":{}};</script>'), /incomplete results/);
});

test('Channel search: channels with ids', () => {
  const list = yt.parseChannelResults(page('channel-search'));
  assert.ok(list.length >= 1 && list.length <= 8);
  for (const c of list) { assert.match(c.channelId, /^UC[\w-]{22}$/); assert.ok(c.title); }
  assert.ok(list.some(c => c.channelId === meta.channelId), 'finds the channel itself');
});

test('reader health: alert after 3 broken reads in a row, once; cleared by a good read', async () => {
  const realFetch = globalThis.fetch, events = [];
  yt.onReaderHealth((reader, error, fails) => events.push(['broken', reader, fails]), reader => events.push(['fixed', reader]));
  let status = 500;
  globalThis.fetch = async () => new Response(status === 200 ? page('search') : 'nope', {status});
  try {
    for (let i = 0; i < 4; i++) await assert.rejects(yt.searchVideos('x'));
    assert.deepEqual(events, [['broken', 'search', 3]], 'one alert at the third failure');
    assert.equal(yt.readerHealth().search.fails, 4);
    status = 200;
    assert.ok((await yt.searchVideos('x')).length >= 5);
    assert.deepEqual(events.at(-1), ['fixed', 'search']);
    assert.equal(yt.readerHealth().search.fails, 0);
    // "Channel not found" is about the input, not a broken reader.
    status = 404;
    for (let i = 0; i < 4; i++) await assert.rejects(yt.loadChannel('@nobody'), /Channel not found/);
    assert.equal(yt.readerHealth().channel?.fails ?? 0, 0);
  } finally { globalThis.fetch = realFetch; yt.onReaderHealth(null, null); }
});

test('In-channel search: videos with views', () => {
  const list = yt.parseChannelVideos(page('in-channel-search'));
  assert.ok(list.length >= 3, 'at least 3 results, got ' + list.length);
  for (const v of list) { assert.match(v.id, VIDEO_ID); assert.ok(v.title); }
  assert.equal(new Set(list.map(v => v.id)).size, list.length, 'no duplicates');
});
