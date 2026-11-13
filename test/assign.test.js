'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a, tess, rob, vic;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  rob = await addUser(ctx.server, a, 'rob', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
});
after(() => ctx.server.stop());

const mk = async (n) => {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await a.post('/api/projects/1/cases', { title: `Case ${i}`, steps: [{ action: 'a', expected: 'b' }] })).data.id);
  return (await a.post('/api/projects/1/cycles', { name: `Assign ${Math.random()}`, caseIds: ids })).data;
};
const runs = async (cy) => (await a.get(`/api/cycles/${cy.id}`)).data.executions;
const tally = (rs) => rs.reduce((m, r) => ({ ...m, [r.assignee_id]: (m[r.assignee_id] || 0) + 1 }), {});
const inbox = async (c) => (await c.get('/api/notifications')).data.items;

test('distributing shares runs evenly, notifies each person once, and respects existing load', async () => {
  const cy = await mk(7);
  const r = await a.ok('POST', `/api/cycles/${cy.id}/assign`, { mode: 'distribute', userIds: [tess.id, rob.id] });
  assert.equal(r.count, 7);
  const t = tally(await runs(cy));
  assert.deepEqual([t[tess.id], t[rob.id]].sort(), [3, 4], 'seven runs split 4 and 3');
  const mine = (await inbox(tess.client)).filter((x) => x.kind === 'run-assigned');
  assert.equal(mine.length, 1, 'one notice, not one per run');
  assert.match(mine[0].title, /assigned you \d test runs in /);
  // running it again changes nothing for runs that already have someone, and stays balanced
  await a.ok('POST', `/api/cycles/${cy.id}/assign`, { mode: 'distribute', userIds: [tess.id, rob.id], only: 'unfinished' });
  const t2 = tally(await runs(cy));
  assert.ok(Math.abs(t2[tess.id] - t2[rob.id]) <= 1);
});

test('only unassigned runs change by default; "unfinished" reassigns; finished runs are left alone; clear works', async () => {
  const cy = await mk(4);
  const rs = await runs(cy);
  await a.ok('PUT', `/api/executions/${rs[0].id}`, { assignee_id: vic.id });
  await a.ok('PUT', `/api/executions/${rs[1].id}`, { status: 'Pass', assignee_id: vic.id });
  const one = await a.ok('POST', `/api/cycles/${cy.id}/assign`, { mode: 'one', userId: tess.id });
  assert.equal(one.count, 2, 'only the two nobody had');
  let now = await runs(cy);
  assert.equal(now.find((r) => r.id === rs[0].id).assignee_id, vic.id, 'existing assignment kept');
  await a.ok('POST', `/api/cycles/${cy.id}/assign`, { mode: 'one', userId: rob.id, only: 'unfinished' });
  now = await runs(cy);
  assert.equal(now.find((r) => r.id === rs[1].id).assignee_id, vic.id, 'a finished run is not reassigned');
  assert.equal(now.filter((r) => r.assignee_id === rob.id).length, 3);
  const cleared = await a.ok('POST', `/api/cycles/${cy.id}/assign`, { mode: 'clear', only: 'all' });
  assert.equal(cleared.count, 4);
  assert.ok((await runs(cy)).every((r) => !r.assignee_id));
});

test('bad input and permissions', async () => {
  const cy = await mk(1);
  assert.equal((await a.post(`/api/cycles/${cy.id}/assign`, { mode: 'nope' })).status, 400);
  assert.equal((await a.post(`/api/cycles/${cy.id}/assign`, { mode: 'distribute', userIds: [] })).status, 400);
  assert.equal((await a.post(`/api/cycles/${cy.id}/assign`, { mode: 'one', userId: 9999 })).status, 400);
  assert.equal((await a.post(`/api/cycles/${cy.id}/assign`, { mode: 'one', userId: tess.id, only: 'x' })).status, 400);
  assert.equal((await vic.client.post(`/api/cycles/${cy.id}/assign`, { mode: 'clear' })).status, 403);
  assert.equal((await a.post('/api/cycles/99999/assign', { mode: 'clear' })).status, 404);
});
