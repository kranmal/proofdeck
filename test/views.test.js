'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a, tess, vic;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
});
after(() => ctx.server.stop());

const list = async (c, scope = 'cases') => (await c.get(`/api/projects/1/views?scope=${scope}`)).data;

test('saved views: private by default, shareable, replaced by name, scoped per list', async () => {
  await a.ok('POST', '/api/projects/1/views', { scope: 'cases', name: 'My drafts', state: { status: 'Draft', term: 'cart', deep: true, folder: '' } });
  assert.deepEqual((await list(a)).map((v) => [v.name, v.shared, v.mine]), [['My drafts', false, true]]);
  assert.equal((await list(tess.client)).length, 0, 'private to its owner');
  assert.equal((await list(a, 'bugs')).length, 0, 'and to its list');
  await a.ok('POST', '/api/projects/1/views', { scope: 'cases', name: 'My drafts', shared: true, state: { status: 'Draft' } });
  const shared = await list(tess.client);
  assert.equal(shared.length, 1);
  assert.deepEqual([shared[0].mine, shared[0].owner, shared[0].state], [false, 'Ada Admin', { status: 'Draft' }], 'saving under the same name replaces it');
  assert.equal((await list(a)).length, 1);
});

test('state is reduced to plain values, names and scopes are checked, viewers stay private', async () => {
  const id = (await a.ok('POST', '/api/projects/1/views', { scope: 'bugs', name: 'Mine', state: { who: 'me', evil: { a: 1 }, 'bad key': 'x', list: [1], n: 5 } })).id;
  assert.deepEqual((await list(a, 'bugs'))[0].state, { who: 'me', n: 5 });
  assert.equal((await a.post('/api/projects/1/views', { scope: 'nope', name: 'x', state: {} })).status, 400);
  assert.equal((await a.post('/api/projects/1/views', { scope: 'bugs', name: '  ', state: {} })).status, 400);
  assert.equal((await a.post('/api/projects/1/views', { scope: 'bugs', name: 'x', state: [1] })).status, 400);
  await vic.client.ok('POST', '/api/projects/1/views', { scope: 'cycles', name: 'Vic view', shared: true, state: { cyfilter: 'overdue' } });
  assert.equal((await list(a, 'cycles')).length, 0, 'a read-only account cannot share');
  assert.equal((await tess.client.del(`/api/views/${id}`)).status, 403);
  await a.ok('DELETE', `/api/views/${id}`);
  assert.equal((await list(a, 'bugs')).length, 0);
});
