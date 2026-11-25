import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {compile, match, readJson, reply, REPLY} from '../server/router.js';

const h = name => () => name;
const table = compile([
  ['GET', '/api/dashboard', h('dashboard')],
  ['POST', '/api/nodes/:id([\\w-]+)/mode', h('mode')],
  ['DELETE', '/api/nodes/:id([\\w-]+)', h('remove')],
  ['GET', '/api/lookup/:id(UC[\\w-]{22})', h('lookup')],
  ['POST', '/api/settings/:hook(discord|slack)', h('hook')],
  ['POST', '/api/settings/:hook(discord|slack)/test', h('hook-test')],
  ['*', '/api/rankings/:rest(.+)', h('rankings')],
  ['GET', '/api/channels/:id(\\d+)/search', h('channel-search')]
]);

test('matches exact paths', () => {
  assert.equal(match(table, 'GET', '/api/dashboard').handler(), 'dashboard');
});
test('extracts parameters', () => {
  const m = match(table, 'POST', '/api/nodes/abc-123/mode');
  assert.equal(m.handler(), 'mode');
  assert.deepEqual(m.params, {id: 'abc-123'});
  assert.deepEqual(match(table, 'GET', '/api/channels/42/search').params, {id: '42'});
});
test('parameter patterns are enforced', () => {
  assert.equal(match(table, 'GET', '/api/lookup/UCshort'), null);
  assert.equal(match(table, 'GET', '/api/lookup/UC' + 'x'.repeat(22)).handler(), 'lookup');
  assert.equal(match(table, 'POST', '/api/settings/telegram'), null);
  assert.equal(match(table, 'GET', '/api/channels/abc/search'), null);
});
test('patterns are anchored (no prefix or suffix matches)', () => {
  assert.equal(match(table, 'GET', '/api/dashboard/extra'), null);
  assert.equal(match(table, 'GET', '/x/api/dashboard'), null);
  assert.equal(match(table, 'POST', '/api/settings/discord/test').handler(), 'hook-test');
});
test('wrong method on a known path is 405, unknown path is null', () => {
  assert.deepEqual(match(table, 'POST', '/api/dashboard'), {status: 405});
  assert.equal(match(table, 'GET', '/api/nope'), null);
});
test("'*' matches any method", () => {
  assert.equal(match(table, 'DELETE', '/api/rankings/subs/3').handler(), 'rankings');
  assert.equal(match(table, 'GET', '/api/rankings/x').handler(), 'rankings');
});
test('reply() marks a non-200 response', () => {
  const r = reply(201, {ok: true});
  assert.equal(r[REPLY], true);
  assert.equal(r.status, 201);
});

const body = text => Readable.from(text ? [Buffer.from(text)] : []);
test('readJson: objects, empty body, bad JSON, wrong type, too large', async () => {
  assert.deepEqual(await readJson(body('{"a":1}')), {a: 1});
  assert.deepEqual(await readJson(body('')), {});
  await assert.rejects(readJson(body('{nope')), e => e.status === 400);
  await assert.rejects(readJson(body('[1,2]')), e => e.status === 400);
  await assert.rejects(readJson(body('"text"')), e => e.status === 400);
  await assert.rejects(readJson(body('x'.repeat(300)), 100), e => e.status === 413);
});
