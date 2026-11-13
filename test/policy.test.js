'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser, Client } = require('./helpers');
const totp = require('../lib/totp');

let ctx, a, tess, vic;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
});
after(() => ctx.server.stop());

const step = () => Math.floor(Date.now() / 30000);

test('policy is admin-only and validated; SSO-only needs SSO on', async () => {
  assert.equal((await tess.client.get('/api/settings/security')).status, 403);
  assert.equal((await a.put('/api/settings/security', { require2fa: 'sometimes' })).status, 400);
  assert.equal((await a.put('/api/settings/security', { ssoOnly: true })).status, 400, 'no SSO yet');
  assert.deepEqual((await a.get('/api/settings/security')).data, { require2fa: 'off', ssoOnly: false });
});

test('"admins" makes admins set up two-factor before anything else works; testers are untouched', async () => {
  await a.ok('PUT', '/api/settings/security', { require2fa: 'admins' });
  const blocked = await a.get('/api/projects');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.needs2faSetup, true);
  assert.equal((await a.get('/api/auth/me')).data.user.must2fa, true);
  assert.equal((await tess.client.get('/api/projects')).status, 200, 'testers are not covered');
  // the account endpoints still work, so they can comply
  const s = await a.ok('POST', '/api/auth/2fa/setup', {});
  await a.ok('POST', '/api/auth/2fa/enable', { code: totp.codeAt(s.secret, step() - 1) });
  assert.equal((await a.get('/api/projects')).status, 200, 'once set up, everything works again');
  assert.equal((await a.get('/api/auth/me')).data.user.must2fa, false);
});

test('"all" covers testers and viewers too, and they can still sign out', async () => {
  await a.ok('PUT', '/api/settings/security', { require2fa: 'all' });
  assert.equal((await tess.client.get('/api/projects')).status, 403);
  assert.equal((await vic.client.get('/api/projects')).status, 403);
  assert.equal((await vic.client.post('/api/auth/logout', {})).status, 200);
  const s = await tess.client.ok('POST', '/api/auth/2fa/setup', {});
  await tess.client.ok('POST', '/api/auth/2fa/enable', { code: totp.codeAt(s.secret, step() - 1) });
  assert.equal((await tess.client.get('/api/projects')).status, 200);
  await a.ok('PUT', '/api/settings/security', { require2fa: 'off' });
  assert.equal((await new Client(ctx.server.base).post('/api/auth/login', { username: 'vic', password: vic.password })).status, 200);
});
