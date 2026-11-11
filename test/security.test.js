'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser, Client } = require('./helpers');

let ctx, a, tess, vic;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
});
after(() => ctx.server.stop());

const audit = async (qs = '') => (await a.get(`/api/audit?limit=200${qs}`)).data.items;

test('sign-in history records successes and failures, admin only, without secrets', async () => {
  const c = new Client(ctx.server.base);
  assert.equal((await c.post('/api/auth/login', { username: 'tess', password: 'wrong password!' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'nobody-here', password: 'wrong password!' })).status, 401);
  const ev = (await a.get('/api/login-events?limit=50')).data.items;
  assert.ok(ev.some((e) => e.username === 'tess' && !e.ok && e.reason === 'wrong password'));
  assert.ok(ev.some((e) => e.username === 'nobody-here' && !e.ok && e.reason === 'unknown user'));
  assert.ok(ev.some((e) => e.username === 'admin' && e.ok && e.reason === 'first-run setup'));
  assert.ok(ev.every((e) => !JSON.stringify(e).includes('wrong password!')), 'passwords never stored');
  assert.ok((await a.get('/api/login-events?fails=1')).data.items.every((e) => !e.ok));
  assert.equal((await tess.client.get('/api/login-events')).status, 403);
  assert.equal((await tess.client.get('/api/audit')).status, 403);
  const mine = (await tess.client.get('/api/auth/history')).data;
  assert.ok(mine.length >= 2 && mine.some((e) => !e.ok) && mine.some((e) => e.ok), 'a user sees their own failed and successful sign-ins');
  assert.ok(mine.every((e) => e.reason !== 'unknown user'));
});

test('the audit log records changes with who, what and where, and never secrets', async () => {
  const before = (await audit()).length;
  const { id } = await a.ok('POST', '/api/users', { username: 'zed', display_name: 'Zed', role: 'viewer', password: 'a long secret pw' });
  await a.ok('PUT', `/api/users/${id}`, { role: 'tester', password: 'another secret pw' });
  const tok = await a.ok('POST', '/api/projects/1/api-tokens', { name: 'Audit token' });
  await a.ok('DELETE', `/api/api-tokens/${tok.id}`);
  const log = await audit();
  assert.ok(log.length > before);
  const find = (action) => log.find((e) => e.action === action);
  assert.equal(find('User created').actor_name, 'Ada Admin');
  assert.match(find('User created').detail, /username: zed/);
  assert.match(find('User changed').detail, /role: tester/);
  assert.match(find('User changed').detail, /password: reset/);
  assert.ok(find('API token created') && find('API token revoked'));
  assert.equal(find('User created').actor_kind, 'user');
  assert.ok(find('User created').ip);
  const all = JSON.stringify(log);
  for (const secret of ['a long secret pw', 'another secret pw', tok.token]) assert.ok(!all.includes(secret), 'no secret in the log');
  // reads and noisy actions are not logged
  const n = (await audit()).length;
  await a.get('/api/projects/1/cases');
  assert.equal((await audit()).length, n);
});

test('the audit log can be searched, filtered by actor and date, and paged', async () => {
  await a.ok('POST', '/api/projects', { name: 'Second', key: 'SEC' });
  assert.ok((await audit('&q=project')).some((e) => e.action === 'Project created'));
  assert.equal((await audit('&q=zzzz-nothing')).length, 0);
  assert.ok((await audit(`&actor=1`)).length > 0);
  assert.equal((await audit('&actor=9999')).length, 0);
  assert.equal((await a.get('/api/audit?from=nope')).status, 400);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok((await audit(`&from=${today}&to=${today}`)).length > 0);
  assert.equal((await audit('&from=2999-01-01')).length, 0);
  const p1 = (await a.get('/api/audit?limit=2')).data;
  assert.equal(p1.items.length, 2);
  assert.ok(p1.next);
  const p2 = (await a.get(`/api/audit?limit=2&before=${p1.next}`)).data;
  assert.ok(p2.items.every((e) => e.id < p1.next));
  assert.ok(!(await audit('&q=%25')).length || (await audit('&q=%25')).every((e) => JSON.stringify(e).includes('%')), 'percent is searched literally');
});

test('actions by an API token are logged under the token name', async () => {
  const tok = (await a.ok('POST', '/api/projects/1/api-tokens', { name: 'CI robot' })).token;
  const r = await fetch(`${ctx.server.base}/api/ci/results`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cycle: { name: 'Audit CI', build: '1' }, results: [{ automation_key: 'audit::login works', title: 'Login works', status: 'Pass' }], autoCreate: true }) });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const e = (await audit()).find((x) => x.action === 'CI results received');
  assert.ok(e);
  assert.equal(e.actor_kind, 'token');
  assert.match(e.actor_name, /CI robot/);
});

test('sessions: list yours, sign out the others, sign out one, admin can sign a user out everywhere', async () => {
  const second = new Client(ctx.server.base);
  await second.ok('POST', '/api/auth/login', { username: 'tess', password: tess.password });
  const third = new Client(ctx.server.base);
  await third.ok('POST', '/api/auth/login', { username: 'tess', password: tess.password });
  const list = (await tess.client.get('/api/auth/sessions')).data;
  assert.equal(list.length, 3);
  assert.equal(list.filter((s) => s.current).length, 1);
  assert.ok(list.every((s) => s.created_at && s.last_seen_at && 'ip' in s && !('token_hash' in s)));
  const other = list.find((s) => !s.current);
  assert.equal((await tess.client.del(`/api/auth/sessions/${other.id}`)).status, 200);
  assert.equal((await tess.client.del(`/api/auth/sessions/${other.id}`)).status, 404, 'already gone');
  assert.equal((await tess.client.del(`/api/auth/sessions/${list.find((s) => s.current).id}`)).status, 404, 'the current one uses sign out');
  // nobody else's session can be touched
  const vlist = (await vic.client.get('/api/auth/sessions')).data;
  assert.equal((await tess.client.del(`/api/auth/sessions/${vlist[0].id}`)).status, 404);
  assert.equal((await vic.client.get('/api/auth/me')).data.user.username, 'vic');
  const r = (await tess.client.post('/api/auth/sessions/revoke-others', {})).data;
  assert.equal(r.count, 1);
  assert.equal((await tess.client.get('/api/auth/sessions')).data.length, 1);
  assert.equal((await tess.client.get('/api/auth/me')).data.user.username, 'tess', 'this session survives');
  assert.equal((await tess.client.post('/api/users/' + tess.id + '/sign-out', {})).status, 403);
  assert.equal((await a.post(`/api/users/${tess.id}/sign-out`, {})).data.count, 1);
  assert.equal((await tess.client.get('/api/auth/me')).data.user, null);
  assert.equal((await a.post('/api/users/9999/sign-out', {})).status, 404);
  assert.ok((await audit()).some((e) => e.action === 'User signed out everywhere'));
});

test('API tokens can expire and be read-only', async () => {
  const bad = (b) => a.post('/api/projects/1/api-tokens', { name: 'x', ...b });
  assert.equal((await bad({ expires_in_days: 0 })).status, 400);
  assert.equal((await bad({ expires_in_days: 1.5 })).status, 400);
  assert.equal((await bad({ expires_in_days: 99999 })).status, 400);
  assert.equal((await bad({ scope: 'admin' })).status, 400);
  const ro = (await bad({ name: 'Gate only', scope: 'read', expires_in_days: 30 })).data;
  assert.equal(ro.scope, 'read');
  assert.ok(Date.parse(ro.expires_at) > Date.now() + 29 * 86400000);
  await a.ok('POST', '/api/projects/1/cycles', { name: 'Gate', build: 'b1', caseIds: [1] });
  const call = (token, method, url, body) => fetch(ctx.server.base + url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  assert.equal((await call(ro.token, 'GET', '/api/ci/cycle?name=Gate&build=b1')).status, 200, 'read tokens can gate a pipeline');
  const w = await call(ro.token, 'POST', '/api/ci/results', { cycle: { name: 'Gate', build: 'b1' }, results: [{ case: 'PD-T1', status: 'Pass' }] });
  assert.equal(w.status, 403);
  assert.match((await w.json()).error, /read-only/);
  const rw = (await bad({ name: 'Expiring' })).data;
  assert.equal(rw.scope, 'write');
  assert.equal(rw.expires_at, null);
  // make one expire (simulate time passing by editing the row directly through a second token with a past date)
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(`${ctx.server.dir}/proofdeck.db`);
  db.prepare('UPDATE api_tokens SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', rw.id);
  db.close();
  const x = await call(rw.token, 'GET', '/api/ci/cycle?name=Gate&build=b1');
  assert.equal(x.status, 401);
  assert.match((await x.json()).error, /expired on 2020-01-01/);
  const list = (await a.get('/api/projects/1/api-tokens')).data;
  assert.ok(list.find((t) => t.id === ro.id).scope === 'read' && list.find((t) => t.id === rw.id).expires_at.startsWith('2020'));
  // an expired token is a known token: repeated use must not lock out the address for good tokens
  for (let i = 0; i < 8; i++) await call(rw.token, 'GET', '/api/ci/cycle?name=Gate&build=b1');
  assert.equal((await call(ro.token, 'GET', '/api/ci/cycle?name=Gate&build=b1')).status, 200);
});

test('old data keeps working: sessions created before the migration have no ip or last-seen', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(`${ctx.server.dir}/proofdeck.db`);
  const cols = db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((c) => c.name);
  db.close();
  for (const c of ['ip', 'user_agent', 'last_seen_at']) assert.ok(cols.includes(c));
});
