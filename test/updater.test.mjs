// The self-updater's decisions, with git/npm/build/restart replaced by a fake that records what was run.
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import * as up from '../server/updater.js';

let calls, repo;
function fake(cmd, args) {
  calls.push([cmd, ...args].join(' '));
  if (cmd === 'build') { if (repo.buildFails) throw new Error('build broke'); return ''; }
  if (cmd === 'sh' || cmd === 'restart') return '';
  const a = args.join(' ');
  if (a === 'rev-parse --abbrev-ref HEAD') return 'main';
  if (a.startsWith('rev-parse --abbrev-ref --symbolic-full-name')) { if (!repo.upstream) throw new Error('no upstream'); return 'origin/main'; }
  if (a.startsWith('fetch')) return '';
  if (a === 'rev-parse --short HEAD') return repo.head;
  if (a === 'rev-parse --short @{u}') return 'bbbbbbb';
  if (a === 'rev-parse HEAD') return repo.head + 'full';
  if (a.startsWith('log -1')) return 'Newest change';
  if (a === 'rev-list --count HEAD..@{u}') return String(repo.behind);
  if (a === 'rev-list --count @{u}..HEAD') return String(repo.ahead);
  if (a.startsWith('status --porcelain')) return repo.dirty ? ' M server/api.js' : '';
  if (a.startsWith('merge --ff-only')) return '';
  if (a.startsWith('diff --name-only')) return repo.changed.join('\n');
  if (a.startsWith('reset --hard')) return '';
  throw new Error('unexpected git ' + a);
}
beforeEach(() => {
  calls = [];
  repo = {head: 'aaaaaaa', behind: 2, ahead: 0, dirty: false, upstream: true, changed: ['server/api.js'], buildFails: false};
  up._configure({run: fake});
  up.setDevServer(false);
  Object.assign(up.update, {state: 'unknown', lastError: null});
});

test('check: reports how far behind GitHub this copy is', async () => {
  const s = await up.check(true);
  assert.equal(s.state, 'available');
  assert.equal(s.behind, 2);
  assert.equal(s.latest, 'bbbbbbb');
  assert.ok(calls.includes('git fetch --quiet origin main'));
});

test('check: up to date', async () => {
  repo.behind = 0;
  assert.equal((await up.check(true)).state, 'current');
});

test('check: no upstream branch means updates are unavailable', async () => {
  repo.upstream = false;
  const s = await up.check(true);
  assert.equal(s.state, 'unavailable');
  assert.match(s.reason, /isn’t linked/);
});

test('apply: pull, build, restart (no npm install when packages are unchanged)', async () => {
  const r = await up.apply();
  assert.equal(r.ok, true);
  assert.ok(calls.includes('git merge --ff-only @{u}'));
  assert.ok(calls.includes('build'));
  assert.ok(calls.includes('restart'));
  assert.ok(!calls.some(c => c.startsWith('sh ')), 'no npm install');
  assert.equal(up.update.state, 'restarting');
});

test('apply: npm install when package.json or the lock file changed', async () => {
  repo.changed = ['package-lock.json', 'server/db.js'];
  await up.apply();
  assert.ok(calls.some(c => c.startsWith('sh npm install')));
});

test('apply: a failed build rolls back and does not restart', async () => {
  repo.buildFails = true;
  const r = await up.apply();
  assert.equal(r.ok, false);
  assert.match(r.message, /building the page/);
  assert.ok(calls.includes('git reset --hard aaaaaaafull'));
  assert.ok(!calls.includes('restart'));
  assert.equal(up.update.state, 'failed');
  assert.ok(up.update.lastError);
});

test('apply: refuses copies with edits or local commits, and dev servers', async () => {
  repo.dirty = true;
  assert.match((await up.apply()).message, /edited files/);
  repo.dirty = false; repo.ahead = 1;
  assert.match((await up.apply()).message, /aren’t on GitHub/);
  repo.ahead = 0; up.setDevServer(true);
  assert.match((await up.apply()).message, /development server/);
  assert.ok(!calls.some(c => c.startsWith('git merge')), 'nothing was pulled');
});

test('apply: nothing to do when up to date', async () => {
  repo.behind = 0;
  const r = await up.apply();
  assert.equal(r.message, 'Already up to date.');
  assert.ok(!calls.includes('build'));
});

test('tick: installs automatically only when switched on and idle', async () => {
  await up.tick({auto: false, busy: false});
  assert.ok(!calls.includes('build'));
  calls = []; up.update.state = 'unknown';
  await up.tick({auto: true, busy: true});
  assert.ok(!calls.includes('build'));
  calls = []; up.update.state = 'unknown';
  await up.tick({auto: true, busy: false});
  assert.ok(calls.includes('build'));
});
