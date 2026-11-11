'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, addUser, Client, rawRequest } = require('./helpers');

let server, admin, tester, viewer;
before(async () => {
  server = await startServer();
  admin = new Client(server.base);
});
after(() => server.stop());

test('everything is locked until someone signs in, except the app shell and /api/auth/me', async () => {
  const anon = new Client(server.base);
  for (const url of ['/api/projects', '/api/projects/1/cases', '/api/users', '/api/attachments/1', '/api/import/template.csv', '/api/projects/1/export']) {
    assert.equal((await anon.get(url)).status, 401, url);
  }
  assert.equal((await anon.post('/api/projects', { name: 'x', key: 'XX' })).status, 401);
  assert.equal((await anon.get('/')).status, 200);
  const me = await anon.get('/api/auth/me');
  assert.deepEqual(me.data, { user: null, needsSetup: true, resetAvailable: false });
});

test('first-run setup creates the admin once, with a hardened session cookie', async () => {
  assert.equal((await admin.post('/api/auth/setup', { username: 'ab', password: 'long enough pw' })).status, 400, 'short username');
  assert.equal((await admin.post('/api/auth/setup', { username: 'admin', password: 'short' })).status, 400, 'short password');
  assert.equal((await admin.post('/api/auth/setup', { username: 'admin', password: 'admin' })).status, 400);
  const r = await admin.post('/api/auth/setup', { username: 'admin', display_name: 'Ada Admin', password: 'correct horse battery' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
  assert.equal(r.data.user.password_hash, undefined, 'never returns the hash');
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('pd_session='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Secure/, 'Secure only when configured');
  assert.equal((await new Client(server.base).post('/api/auth/setup', { username: 'second', password: 'another good one' })).status, 403);
  assert.equal((await admin.get('/api/auth/me')).data.user.username, 'admin');
  assert.equal((await admin.get('/api/projects')).status, 200);
});

test('login: wrong password and unknown user look identical; logout kills the session', async () => {
  const c = new Client(server.base);
  const bad = await c.post('/api/auth/login', { username: 'admin', password: 'nope nope nope' });
  const none = await c.post('/api/auth/login', { username: 'nobody', password: 'nope nope nope' });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.data, none.data);
  assert.equal((await c.post('/api/auth/login', { username: 'ADMIN', password: 'correct horse battery' })).status, 200, 'username is case-insensitive');
  const stolen = c.cookie;
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  const replay = new Client(server.base);
  replay.cookie = stolen;
  assert.equal((await replay.get('/api/projects')).status, 401, 'old token is dead');
});

test('five wrong passwords lock that account+address, even for the right password', async () => {
  const { id } = await admin.ok('POST', '/api/users', { username: 'victim', password: 'victim password 1', role: 'tester' });
  assert.ok(id);
  const c = new Client(server.base);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/login', { username: 'victim', password: 'wrong wrong ' + i })).status, 401);
  const locked = await c.post('/api/auth/login', { username: 'victim', password: 'victim password 1' });
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /Try again in \d+ seconds/);
});

test('roles: viewers read only, testers cannot administer, users list is minimal for non-admins', async () => {
  tester = await addUser(server, admin, 'tess', 'tester');
  viewer = await addUser(server, admin, 'vic', 'viewer');
  assert.equal((await viewer.client.get('/api/projects/1/cases')).status, 200);
  assert.equal((await viewer.client.post('/api/projects', { name: 'Nope', key: 'NOPE' })).status, 403);
  assert.equal((await viewer.client.put('/api/cases/1', { title: 'x' })).status, 403);
  assert.equal((await viewer.client.del('/api/cases/1')).status, 403);
  assert.equal((await tester.client.post('/api/projects', { name: 'Mine', key: 'MINE' })).status, 200);
  assert.equal((await tester.client.post('/api/users', { username: 'x1234', password: 'long enough pw', role: 'admin' })).status, 403);
  assert.equal((await tester.client.put('/api/users/1', { role: 'viewer' })).status, 403);
  const list = (await tester.client.get('/api/users')).data;
  assert.ok(list.length >= 3);
  assert.deepEqual(Object.keys(list[0]).sort(), ['display_name', 'id', 'username']);
  const full = (await admin.get('/api/users')).data;
  assert.ok(full.every((u) => 'role' in u && 'active' in u) && full.every((u) => !('password_hash' in u)));
  assert.equal((await viewer.client.post('/api/auth/logout')).status, 200, 'viewers can still sign out');
  await viewer.client.ok('POST', '/api/auth/login', { username: 'vic', password: viewer.password });
});

test('the last active admin cannot be demoted or deactivated', async () => {
  const me = (await admin.get('/api/auth/me')).data.user;
  assert.equal((await admin.put(`/api/users/${me.id}`, { role: 'tester' })).status, 400);
  assert.equal((await admin.put(`/api/users/${me.id}`, { active: false })).status, 400);
  const second = await addUser(server, admin, 'boss2', 'admin');
  assert.equal((await admin.put(`/api/users/${me.id}`, { role: 'tester' })).status, 200);
  assert.equal((await second.client.put(`/api/users/${me.id}`, { role: 'admin' })).status, 200);
});

test('deactivating or resetting a user ends their sessions', async () => {
  const u = await addUser(server, admin, 'temp1', 'tester');
  assert.equal((await u.client.get('/api/projects')).status, 200);
  assert.equal((await admin.put(`/api/users/${u.id}`, { password: 'brand new password' })).status, 200);
  assert.equal((await u.client.get('/api/projects')).status, 401, 'reset logs them out');
  assert.equal((await new Client(server.base).post('/api/auth/login', { username: 'temp1', password: u.password })).status, 401);
  const again = new Client(server.base);
  assert.equal((await again.post('/api/auth/login', { username: 'temp1', password: 'brand new password' })).status, 200);
  assert.equal((await admin.put(`/api/users/${u.id}`, { active: false })).status, 200);
  assert.equal((await again.get('/api/projects')).status, 401, 'deactivated accounts lose access immediately');
  assert.equal((await new Client(server.base).post('/api/auth/login', { username: 'temp1', password: 'brand new password' })).status, 401);
  assert.equal((await admin.post('/api/users', { username: 'TEMP1', password: 'whatever pass 1' })).status, 409, 'usernames are unique ignoring case');
});

test('changing your password needs the current one and signs out your other sessions', async () => {
  const u = await addUser(server, admin, 'pwuser', 'tester');
  const other = new Client(server.base);
  await other.ok('POST', '/api/auth/login', { username: 'pwuser', password: u.password });
  assert.equal((await u.client.post('/api/auth/password', { current: 'wrong wrong 1', next: 'a brand new pass' })).status, 400);
  assert.equal((await u.client.post('/api/auth/password', { current: u.password, next: 'short' })).status, 400);
  assert.equal((await u.client.post('/api/auth/password', { current: u.password, next: 'a brand new pass' })).status, 200);
  assert.equal((await u.client.get('/api/projects')).status, 200, 'this session survives');
  assert.equal((await other.get('/api/projects')).status, 401, 'other sessions do not');
  assert.equal((await new Client(server.base).post('/api/auth/login', { username: 'pwuser', password: u.password })).status, 401);
});

test('writes from another origin or without JSON are refused', async () => {
  const headers = { 'Content-Type': 'application/json', Cookie: tester.client.cookie };
  const body = JSON.stringify({ name: 'Evil', key: 'EVIL' });
  const cross = await rawRequest(server.base, 'POST', '/api/projects', { headers: { ...headers, Origin: 'http://evil.example' }, body });
  assert.equal(cross.status, 403);
  const nullOrigin = await rawRequest(server.base, 'POST', '/api/projects', { headers: { ...headers, Origin: 'null' }, body });
  assert.equal(nullOrigin.status, 403);
  const same = await rawRequest(server.base, 'POST', '/api/projects', { headers: { ...headers, Origin: server.base }, body });
  assert.equal(same.status, 200);
  const form = await rawRequest(server.base, 'POST', '/api/projects', { headers: { 'Content-Type': 'text/plain', Cookie: tester.client.cookie }, body });
  assert.equal(form.status, 415);
  const del = await rawRequest(server.base, 'DELETE', '/api/cases/999', { headers: { Cookie: tester.client.cookie, Origin: 'http://evil.example' } });
  assert.equal(del.status, 403);
});

test('who did what: cases, executions, bugs and comments are attributed', async () => {
  const t = tester.client;
  const c = await t.ok('POST', '/api/projects/1/cases', { title: 'Attributed', steps: [{ action: 'a', expected: 'b' }] });
  assert.equal((await t.get(`/api/cases/${c.id}`)).data.created_by_name, 'TESS');
  await admin.ok('PUT', `/api/cases/${c.id}`, { title: 'Attributed v2' });
  const edited = (await t.get(`/api/cases/${c.id}`)).data;
  assert.equal(edited.created_by_name, 'TESS');
  assert.equal(edited.updated_by_name, 'Ada Admin');

  const cycle = await t.ok('POST', '/api/projects/1/cycles', { name: 'Attr cycle', caseIds: [c.id] });
  assert.equal((await t.get(`/api/cycles/${cycle.id}`)).data.created_by_name, 'TESS');
  const exec = (await t.get(`/api/cycles/${cycle.id}`)).data.executions[0];
  assert.equal(exec.executed_by_name, null);
  assert.equal((await t.put(`/api/executions/${exec.id}`, { assignee_id: 99999 })).status, 400, 'unknown assignee');
  await t.ok('PUT', `/api/executions/${exec.id}`, { assignee_id: tester.id });
  const full = (await t.get(`/api/executions/${exec.id}`)).data;
  await t.ok('PUT', `/api/step-results/${full.steps[0].id}`, { status: 'Fail', actual: 'broke' });
  const after = (await t.get(`/api/executions/${exec.id}`)).data;
  assert.equal(after.assignee_name, 'TESS');
  assert.equal(after.executed_by_name, 'TESS');
  assert.equal(after.status, 'Fail');

  const bug = await t.ok('POST', `/api/step-results/${full.steps[0].id}/bug`, {});
  await t.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: tester.id });
  const b = (await t.get(`/api/bugs/${bug.id}`)).data;
  assert.equal(b.reporter_name, 'TESS');
  assert.equal(b.assignee_name, 'TESS');
  await t.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: null });
  assert.equal((await t.get(`/api/bugs/${bug.id}`)).data.assignee_name, null);
  assert.equal((await t.put(`/api/bugs/${bug.id}`, { assignee_id: 'abc' })).status, 400);

  const cm = await t.ok('POST', `/api/bugs/${bug.id}/comments`, { body: '  Seen on staging too  ' });
  assert.equal((await t.post(`/api/bugs/${bug.id}/comments`, { body: '   ' })).status, 400);
  const comments = (await t.get(`/api/bugs/${bug.id}`)).data.comments;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].author, 'TESS');
  assert.equal(comments[0].body, 'Seen on staging too');
  assert.equal((await viewer.client.post(`/api/bugs/${bug.id}/comments`, { body: 'hi' })).status, 403, 'viewers cannot comment');
  const other = await addUser(server, admin, 'tom', 'tester');
  assert.equal((await other.client.del(`/api/bug-comments/${cm.id}`)).status, 403, "cannot delete someone else's comment");
  assert.equal((await admin.del(`/api/bug-comments/${cm.id}`)).status, 200, 'admins can');
});

test('the Secure flag is added to the cookie when configured', async () => {
  const s2 = await startServer({ COOKIE_SECURE: '1' });
  try {
    const c = new Client(s2.base);
    const r = await c.post('/api/auth/setup', { username: 'sec', password: 'secure password 1' });
    assert.match(r.headers.getSetCookie()[0], /; Secure/);
  } finally { s2.stop(); }
});
