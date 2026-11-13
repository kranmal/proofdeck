'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { startAdmin, addUser, Client } = require('./helpers');
const totp = require('../lib/totp');

let ctx, a, tess;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
});
after(() => ctx.server.stop());

const step = () => Math.floor(Date.now() / 30000);
const login = (c, u) => c.post('/api/auth/login', { username: u.username || 'tess', password: u.password });
const fresh = () => new Client(ctx.server.base);
let secret, codes;

test('setting up: nothing is enforced until a real code proves the app works', async () => {
  const me = (await tess.client.get('/api/auth/me')).data.user;
  assert.equal(me.totp, false);
  const s = await tess.client.ok('POST', '/api/auth/2fa/setup', {});
  secret = s.secret;
  assert.match(s.secret, /^[A-Z2-7]{32}$/);
  assert.match(s.uri, /^otpauth:\/\/totp\/Proofdeck:tess\?secret=/);
  assert.match(s.qr, /^<svg [^>]*aria-label="QR code/);
  assert.equal((await login(fresh(), tess)).status, 200, 'still just a password');
  assert.equal((await tess.client.post('/api/auth/2fa/enable', { code: '000000' })).status, 400);
  assert.equal((await tess.client.post('/api/auth/2fa/enable', { code: 'abcdef' })).status, 400);
  const r = await tess.client.ok('POST', '/api/auth/2fa/enable', { code: totp.codeAt(secret, step() - 1) });
  codes = r.recoveryCodes;
  assert.equal(codes.length, 10);
  assert.match(codes[0], /^[0-9a-f]{6}-[0-9a-f]{6}$/);
  assert.equal((await tess.client.get('/api/auth/me')).data.user.totp, true);
  assert.equal((await tess.client.post('/api/auth/2fa/setup', {})).status, 400, 'cannot restart while on');
  const raw = require('node:fs').readFileSync(path.join(ctx.server.dir, 'proofdeck.db'));
  assert.ok(!raw.includes(secret), 'the secret is stored encrypted');
});

test('signing in needs the password and then a code; a code works only once; wrong codes are refused', async () => {
  const c = fresh();
  const first = await login(c, tess);
  assert.equal(first.status, 200);
  assert.equal(first.data.needs2fa, true);
  assert.equal(first.data.user, undefined);
  assert.equal((await c.get('/api/projects')).status, 401, 'no session yet');
  assert.equal((await c.post('/api/auth/login/2fa', { ticket: first.data.ticket, code: '123456' })).status, 401);
  assert.equal((await c.post('/api/auth/login/2fa', { ticket: 'nonsense', code: totp.codeAt(secret, step()) })).status, 401);
  const ok = await c.post('/api/auth/login/2fa', { ticket: first.data.ticket, code: totp.codeAt(secret, step()) });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.username, 'tess');
  assert.equal((await c.get('/api/projects')).status, 200, 'signed in');
  // the same code again (replay) is refused, even with a fresh ticket
  const c2 = fresh();
  const t2 = (await login(c2, tess)).data.ticket;
  assert.equal((await c2.post('/api/auth/login/2fa', { ticket: t2, code: totp.codeAt(secret, step()) })).status, 401, 'a code cannot be reused');
  assert.equal((await c2.post('/api/auth/login/2fa', { ticket: t2, code: totp.codeAt(secret, step() + 1) })).status, 200, 'the next step is fine');
  assert.equal((await login(fresh(), { username: 'tess', password: 'wrong' })).status, 401);
});

test('a recovery code works once; a ticket dies after five wrong codes; the account locks after repeated misses', async () => {
  const c = fresh();
  const t = (await login(c, tess)).data.ticket;
  const used = await c.post('/api/auth/login/2fa', { ticket: t, code: codes[0] });
  assert.equal(used.status, 200, 'recovery code accepted');
  const c3 = fresh();
  const t3 = (await login(c3, tess)).data.ticket;
  assert.equal((await c3.post('/api/auth/login/2fa', { ticket: t3, code: codes[0] })).status, 401, 'but only once');
  assert.equal((await c3.post('/api/auth/login/2fa', { ticket: t3, code: codes[1] })).status, 200, 'another one still works');
  // five wrong codes kill the ticket, and they also count against the account
  const c4 = fresh();
  const t4 = (await login(c4, tess)).data.ticket;
  for (let i = 0; i < 5; i++) assert.equal((await c4.post('/api/auth/login/2fa', { ticket: t4, code: '000000' })).status, 401);
  assert.equal((await c4.post('/api/auth/login/2fa', { ticket: t4, code: codes[2] })).status, 401, 'the ticket is gone');
  const t5 = (await login(c4, tess)).data.ticket;
  assert.equal((await c4.post('/api/auth/login/2fa', { ticket: t5, code: codes[2] })).status, 429, 'the account waits, even for a right code');
});

test('turning it off needs the password and a code; an admin can reset it; the CLI can too', async () => {
  // the account was paused above, so use the admin reset path first
  assert.equal((await tess.client.post('/api/auth/2fa/disable', { password: 'wrong', code: codes[3] })).status, 400);
  assert.equal((await tess.client.post('/api/auth/2fa/disable', { password: tess.password, code: '111111' })).status, 400);
  await tess.client.ok('POST', '/api/auth/2fa/disable', { password: tess.password, code: codes[3] });
  assert.equal((await login(fresh(), tess)).data.user.username, 'tess', 'back to password only');

  // admin reset
  await tess.client.ok('POST', '/api/auth/2fa/setup', {});
  const s2 = (await tess.client.post('/api/auth/2fa/setup', {})).data; // second call while still pending is fine
  await tess.client.ok('POST', '/api/auth/2fa/enable', { code: totp.codeAt(s2.secret, step()) });
  assert.equal((await a.get('/api/users')).data.find((u) => u.username === 'tess').totp, 1);
  assert.equal((await tess.client.post('/api/users/1/2fa-reset', {})).status, 403, 'not for testers');
  await a.ok('POST', `/api/users/${tess.id}/2fa-reset`, {});
  assert.equal((await login(fresh(), tess)).data.user.username, 'tess');

  // CLI
  await tess.client.ok('POST', '/api/auth/2fa/setup', {});
  const s3 = (await tess.client.post('/api/auth/2fa/setup', {})).data;
  await tess.client.ok('POST', '/api/auth/2fa/enable', { code: totp.codeAt(s3.secret, step()) });
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'reset-password.js'), 'tess', '--clear-2fa', '--password-stdin'], { env: { ...process.env, DATA_DIR: ctx.server.dir }, input: 'a brand new password 1\n' });
  assert.equal((await login(fresh(), { username: 'tess', password: 'a brand new password 1' })).data.user.username, 'tess');
});
