import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeToken, checkToken, bearer, samePassword, isLocal} from '../server/auth.js';

test('passes: valid, wrong secret, tampered, expired', () => {
  const {token} = makeToken('secret-a');
  assert.equal(checkToken(token, 'secret-a'), true);
  assert.equal(checkToken(token, 'secret-b'), false);
  assert.equal(checkToken(token.slice(0, -2) + 'xx', 'secret-a'), false);
  assert.equal(checkToken(makeToken('secret-a', -1).token, 'secret-a'), false);
  assert.equal(checkToken(null, 'secret-a'), false);
  assert.equal(checkToken(token, ''), false);
});
test('bearer() reads the Authorization header', () => {
  assert.equal(bearer({headers: {authorization: 'Bearer abc.def'}}), 'abc.def');
  assert.equal(bearer({headers: {}}), null);
});
test('samePassword()', () => {
  assert.equal(samePassword('hunter2', 'hunter2'), true);
  assert.equal(samePassword('hunter', 'hunter2'), false);
  assert.equal(samePassword(undefined, ''), true);
});

const req = (ip, host, extra = {}) => ({socket: {remoteAddress: ip}, headers: {host, ...extra}});
test('isLocal(): home network directly', () => {
  assert.equal(isLocal(req('192.168.1.20', '192.168.1.5:4173')), true);
  assert.equal(isLocal(req('::ffff:127.0.0.1', 'localhost:5173')), true);
  assert.equal(isLocal(req('10.0.0.4', 'desktop-pc:4173')), true);
});
test('isLocal(): internet, tunnels and DNS rebinding are not local', () => {
  assert.equal(isLocal(req('8.8.8.8', '192.168.1.5:4173')), false);
  assert.equal(isLocal(req('127.0.0.1', 'x.trycloudflare.com', {'cf-connecting-ip': '1.2.3.4'})), false);
  assert.equal(isLocal(req('127.0.0.1', 'localhost', {'x-forwarded-for': '1.2.3.4'})), false);
  assert.equal(isLocal(req('192.168.1.20', 'evil.example.com')), false);
});
