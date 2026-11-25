// The snapshot-thinning SQL, run on an in-memory database with the dashboard's tables.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'libsql';
import {THIN_VIDEOS, THIN_CHANNELS, LAUNCH_DAYS} from '../server/retention.js';

const HOUR = 3600e3, DAY = 24 * HOUR, now = Date.parse('2026-06-01T12:00:00.000Z');
const iso = t => new Date(t).toISOString();

function fresh() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE videos (id TEXT PRIMARY KEY, channel INTEGER, published TEXT);
    CREATE TABLE video_snapshots (video TEXT, ts TEXT, views INTEGER, likes INTEGER);
    CREATE TABLE channel_snapshots (channel INTEGER, ts TEXT, subscribers INTEGER, total_views INTEGER, video_count INTEGER);`);
  return db;
}

test('video snapshots: old days thinned to one, launch window and recent data kept', () => {
  const db = fresh();
  const published = now - 200 * DAY;
  db.prepare(`INSERT INTO videos VALUES ('vid00000001', 1, ?)`).run(iso(published));
  const snap = db.prepare(`INSERT INTO video_snapshots VALUES ('vid00000001', ?, ?, 0)`);
  // Hourly snapshots from publish for 200 days.
  for (let t = published + HOUR, n = 1; t < now; t += HOUR, n++) snap.run(iso(t), n);
  const cutoff = iso(now - 60 * DAY);
  const before = db.prepare(`SELECT count(*) n FROM video_snapshots`).get().n;
  db.prepare(THIN_VIDEOS).run(cutoff, cutoff, LAUNCH_DAYS);

  const launch = db.prepare(`SELECT count(*) n FROM video_snapshots WHERE ts <= ?`).get(iso(published + LAUNCH_DAYS * DAY)).n;
  assert.equal(launch, LAUNCH_DAYS * 24, 'every hourly point in the launch window is kept');
  const recent = db.prepare(`SELECT count(*) n FROM video_snapshots WHERE ts >= ?`).get(cutoff).n;
  assert.equal(recent, Math.floor((now - Date.parse(cutoff)) / HOUR), 'nothing newer than the cutoff is touched');
  const perDay = db.prepare(`SELECT substr(ts,1,10) d, count(*) n, max(views) v FROM video_snapshots WHERE ts < ? AND ts > ? GROUP BY d`).all(cutoff, iso(published + (LAUNCH_DAYS + 1) * DAY));
  assert.ok(perDay.length > 100);
  assert.ok(perDay.every(r => r.n === 1), 'one snapshot per old day');
  // The one kept is the day's last (highest views, since views only grow here).
  const last = db.prepare(`SELECT max(views) v FROM video_snapshots WHERE substr(ts,1,10)=?`);
  assert.equal(perDay[5].v, last.get(perDay[5].d).v);
  // 96 launch + 1440 recent + one per remaining old day.
  const days = Math.round((Date.parse(cutoff) - published) / DAY) - LAUNCH_DAYS;
  assert.ok(Math.abs(db.prepare(`SELECT count(*) n FROM video_snapshots`).get().n - (LAUNCH_DAYS * 24 + 60 * 24 + days)) <= 2);
  assert.ok(db.prepare(`SELECT count(*) n FROM video_snapshots`).get().n < before / 2);
});

test('video snapshots: a video with no publish date is thinned normally', () => {
  const db = fresh();
  db.prepare(`INSERT INTO videos VALUES ('vid00000002', 1, NULL)`).run();
  const snap = db.prepare(`INSERT INTO video_snapshots VALUES ('vid00000002', ?, 1, 0)`);
  for (let h = 0; h < 48; h++) snap.run(iso(now - 100 * DAY + h * HOUR));
  const cutoff = iso(now - 60 * DAY);
  db.prepare(THIN_VIDEOS).run(cutoff, cutoff, LAUNCH_DAYS);
  assert.ok(db.prepare(`SELECT count(*) n FROM video_snapshots`).get().n <= 3);
});

test('channel snapshots: old days thinned to one per channel, recent kept', () => {
  const db = fresh();
  const snap = db.prepare(`INSERT INTO channel_snapshots VALUES (?, ?, ?, 0, 0)`);
  for (const ch of [1, 2]) for (let t = now - 150 * DAY; t < now; t += HOUR) snap.run(ch, iso(t), Math.round((t - now) / HOUR));
  const cutoff = iso(now - 90 * DAY);
  db.prepare(THIN_CHANNELS).run(cutoff, cutoff);
  const old = db.prepare(`SELECT channel, substr(ts,1,10) d, count(*) n FROM channel_snapshots WHERE ts < ? GROUP BY channel, d`).all(cutoff);
  assert.ok(old.every(r => r.n === 1));
  assert.equal(new Set(old.map(r => r.channel)).size, 2, 'both channels keep their history');
  for (const ch of [1, 2]) assert.equal(db.prepare(`SELECT count(*) n FROM channel_snapshots WHERE channel=? AND ts >= ?`).get(ch, cutoff).n, 90 * 24);
});
