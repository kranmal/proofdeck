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

test('a template captures a case, can be listed, replaced by name, used to start a case, and deleted by its owner or an admin', async () => {
  await a.ok('PUT', '/api/cases/2', { objective: 'Cart works', precondition: 'Logged in', priority: 'High', labels: 'smoke, cart' });
  const field = (await a.post('/api/projects/1/fields', { entity: 'case', label: 'Component', type: 'text' })).data;
  assert.ok(field.id || field.key);
  await a.ok('PUT', '/api/cases/2', { fields: { component: 'Cart' } });
  const t = await tess.client.ok('POST', '/api/projects/1/templates', { name: 'Checkout flow', caseId: 2 });
  const list = (await a.get('/api/projects/1/templates')).data;
  assert.deepEqual([list.length, list[0].name, list[0].steps, list[0].created_by_name], [1, 'Checkout flow', 3, 'TESS']);
  const full = (await a.get(`/api/templates/${t.id}`)).data;
  assert.equal(full.data.objective, 'Cart works');
  assert.equal(full.data.priority, 'High');
  assert.equal(full.data.steps.length, 3);
  assert.equal(full.data.steps[0].action, 'Open any product page');
  assert.equal(full.data.fields.component, 'Cart');
  assert.ok(!('title' in full.data) && !('key' in full.data), 'no title or key: those are new each time');
  // use it
  const made = await a.ok('POST', '/api/projects/1/cases', { title: 'Checkout as guest', ...full.data });
  const c = (await a.get(`/api/cases/${made.id}`)).data;
  assert.deepEqual([c.title, c.objective, c.priority, c.steps.length, c.fields.component], ['Checkout as guest', 'Cart works', 'High', 3, 'Cart']);
  // same name replaces
  await a.ok('PUT', '/api/cases/2', { priority: 'Low' });
  const again = await a.ok('POST', '/api/projects/1/templates', { name: 'Checkout flow', caseId: 2 });
  assert.equal(again.id, t.id);
  assert.equal((await a.get(`/api/templates/${t.id}`)).data.data.priority, 'Low');
  assert.equal((await a.get('/api/projects/1/templates')).data.length, 1);
  // permissions
  assert.equal((await vic.client.post('/api/projects/1/templates', { name: 'x', caseId: 2 })).status, 403, 'read-only accounts cannot save');
  const mine = await a.ok('POST', '/api/projects/1/templates', { name: 'Admin only', caseId: 1 });
  assert.equal((await tess.client.del(`/api/templates/${mine.id}`)).status, 403);
  assert.equal((await tess.client.del(`/api/templates/${t.id}`)).status, 403, 'saving over a template makes you its owner');
  const own = await tess.client.ok('POST', '/api/projects/1/templates', { name: 'Tess own', caseId: 3 });
  await tess.client.ok('DELETE', `/api/templates/${own.id}`);
  await a.ok('DELETE', `/api/templates/${t.id}`);
  await a.ok('DELETE', `/api/templates/${mine.id}`);
  assert.equal((await a.get('/api/projects/1/templates')).data.length, 0);
});

test('bad input is refused; steps that call other cases are left out', async () => {
  assert.equal((await a.post('/api/projects/1/templates', { name: '', caseId: 1 })).status, 400);
  assert.equal((await a.post('/api/projects/1/templates', { name: 'x', caseId: 9999 })).status, 404);
  const callee = (await a.post('/api/projects/1/cases', { title: 'Callee', steps: [{ action: 'do', expected: 'ok' }] })).data;
  const caller = (await a.post('/api/projects/1/cases', { title: 'Caller', steps: [{ action: 'first', expected: 'x' }, { call_case_id: callee.id }] })).data;
  const t = await a.ok('POST', '/api/projects/1/templates', { name: 'With call', caseId: caller.id });
  assert.deepEqual((await a.get(`/api/templates/${t.id}`)).data.data.steps.map((s) => s.action), ['first']);
});
