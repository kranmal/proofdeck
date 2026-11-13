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

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// A bug raised from a failed step is linked to its case, run and step.
const stepBug = async (title) => {
  const ex = (await a.get('/api/executions/2')).data;
  await a.ok('PUT', `/api/step-results/${ex.steps[0].id}`, { status: 'Fail', actual: 'broke' });
  return (await a.post(`/api/step-results/${ex.steps[0].id}/bug`, { title })).data;
};
const trash = async (c = a) => (await c.get('/api/projects/1/trash')).data.items;

test('a deleted bug comes back whole: comments, files, links to its run, even when its id was reused', async () => {
  const bug = await stepBug('Trash me');
  await a.ok('POST', `/api/bugs/${bug.id}/comments`, { body: 'remember this' });
  await a.ok('POST', `/api/bugs/${bug.id}/attachments`, { filename: 's.png', mime: 'image/png', data: png });
  await a.ok('DELETE', `/api/bugs/${bug.id}`);
  assert.equal((await a.get(`/api/bugs/${bug.id}`)).status, 404);
  const items = await trash();
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].kind, items[0].label.startsWith(bug.key), items[0].deleted_by_name], ['bug', true, 'Ada Admin']);
  // a new bug takes the freed id
  const other = (await a.post('/api/projects/1/bugs', { title: 'Newcomer', actual: 'x' })).data;
  assert.equal(other.id, bug.id, 'ids are reused, which restore has to cope with');
  const r = await a.ok('POST', `/api/trash/${items[0].id}/restore`, {});
  assert.equal(r.kind, 'bug');
  assert.notEqual(r.id, bug.id);
  const back = (await a.get(`/api/bugs/${r.id}`)).data;
  assert.equal(back.title, 'Trash me');
  assert.equal(back.key, bug.key, 'it keeps its key');
  assert.equal(back.case_id, 2);
  assert.ok(back.execution_id, 'and its run');
  assert.equal(back.comments.length, 1);
  assert.equal(back.attachments.length, 1);
  assert.equal((await a.get(`/api/attachments/${back.attachments[0].id}`)).headers.get('content-type'), 'image/png');
  assert.equal((await a.get(`/api/bugs/${other.id}`)).data.title, 'Newcomer', 'the newcomer is untouched');
  assert.equal((await trash()).length, 0, 'the trash item is gone once restored');
});

test('a deleted test case returns with steps, versions, comments, files and its place in runs and bugs', async () => {
  await a.ok('POST', '/api/cases/2/comments', { body: 'keep me' });
  await a.ok('POST', '/api/cases/2/attachments', { filename: 'a.png', mime: 'image/png', data: png });
  const before = (await a.get('/api/cases/2')).data;
  const ex = (await a.get('/api/executions/2')).data;
  assert.equal(ex.case_id, 2);
  const bug = await stepBug('Linked');
  await a.ok('DELETE', '/api/cases/2');
  assert.equal((await a.get('/api/executions/2')).data.case_id, null, 'delete detaches runs as before');
  const item = (await trash()).find((x) => x.kind === 'case');
  await a.ok('POST', `/api/trash/${item.id}/restore`, {});
  const c = (await a.get('/api/cases/2')).data;
  assert.equal(c.title, before.title);
  assert.equal(c.steps.length, before.steps.length);
  assert.deepEqual(c.steps.map((s) => s.action), before.steps.map((s) => s.action));
  assert.equal(c.comments.length, 1);
  assert.equal(c.attachments.length, 1);
  assert.equal((await a.get('/api/executions/2')).data.case_id, 2, 'its runs point at it again');
  assert.equal((await a.get(`/api/bugs/${bug.id}`)).data.case_id, 2, 'and its bugs');
  assert.ok((await a.get('/api/cases/2/versions')).data.length >= 1, 'version history survives');
});

test('a deleted cycle returns with its runs, step results and screenshots, and bulk-deleted cases each reach the trash', async () => {
  const cy = (await a.post('/api/projects/1/cycles', { name: 'Doomed', caseIds: [1, 3] })).data;
  const cycle = (await a.get(`/api/cycles/${cy.id}`)).data;
  const run = cycle.executions[0];
  const full = (await a.get(`/api/executions/${run.id}`)).data;
  await a.ok('PUT', `/api/step-results/${full.steps[0].id}`, { status: 'Fail', actual: 'nope' });
  await a.ok('POST', `/api/step-results/${full.steps[0].id}/attachments`, { filename: 's.png', mime: 'image/png', data: png });
  await a.ok('POST', `/api/executions/${run.id}/comments`, { body: 'run note' });
  await a.ok('DELETE', `/api/cycles/${cy.id}`);
  assert.equal((await a.get(`/api/executions/${run.id}`)).status, 404);
  const item = (await trash()).find((x) => x.kind === 'cycle');
  await a.ok('POST', `/api/trash/${item.id}/restore`, {});
  const back = (await a.get(`/api/cycles/${cy.id}`)).data;
  assert.equal(back.name, 'Doomed');
  assert.equal(back.executions.length, 2);
  const ex = (await a.get(`/api/executions/${run.id}`)).data;
  assert.equal(ex.steps[0].status, 'Fail');
  assert.equal(ex.steps[0].attachments.length, 1);
  assert.equal(ex.comments.length, 1);

  const extra = [(await a.post('/api/projects/1/cases', { title: 'Bulk one' })).data.id, (await a.post('/api/projects/1/cases', { title: 'Bulk two' })).data.id];
  const keep = (await trash()).length;
  await a.ok('POST', '/api/projects/1/cases/bulk', { action: 'delete', ids: extra });
  assert.equal((await trash()).length, keep + 2);
});

test('permissions and housekeeping: viewers cannot restore, only admins delete for good, and the list is per project', async () => {
  const bug = (await a.post('/api/projects/1/bugs', { title: 'Perm', actual: 'x' })).data;
  await tess.client.ok('DELETE', `/api/bugs/${bug.id}`);
  const item = (await trash(tess.client)).find((x) => x.label.includes('Perm'));
  assert.ok(item.deleted_by_name, 'it records who deleted it');
  assert.equal((await vic.client.post(`/api/trash/${item.id}/restore`, {})).status, 403);
  assert.equal((await tess.client.del(`/api/trash/${item.id}`)).status, 403);
  await a.ok('DELETE', `/api/trash/${item.id}`);
  assert.equal((await a.post(`/api/trash/${item.id}/restore`, {})).status, 404);
  const n = (await trash()).length;
  assert.ok(n > 0);
  assert.equal((await a.del('/api/projects/1/trash')).data.count, n);
  assert.equal((await trash()).length, 0);
});

test('a single run removed from a cycle can be restored with its results, files, comments and bug links', async () => {
  const cy = (await a.post('/api/projects/1/cycles', { name: 'Run trash', caseIds: [1, 3] })).data;
  const run = (await a.get(`/api/cycles/${cy.id}`)).data.executions[0];
  const ex = (await a.get(`/api/executions/${run.id}`)).data;
  await a.ok('PUT', `/api/step-results/${ex.steps[0].id}`, { status: 'Fail', actual: 'x' });
  await a.ok('POST', `/api/step-results/${ex.steps[0].id}/attachments`, { filename: 's.png', mime: 'image/png', data: png });
  await a.ok('POST', `/api/executions/${run.id}/comments`, { body: 'note' });
  const bug = (await a.post(`/api/step-results/${ex.steps[0].id}/bug`, { title: 'From run' })).data;
  const del = await a.ok('DELETE', `/api/executions/${run.id}`);
  assert.ok(del.trashId);
  assert.equal((await a.get(`/api/bugs/${bug.id}`)).data.execution_id, null, 'the bug is detached as before');
  const item = (await trash()).find((x) => x.kind === 'execution');
  assert.match(item.label, /^Run of /);
  const r = await a.ok('POST', `/api/trash/${item.id}/restore`, {});
  assert.deepEqual([r.kind, r.id], ['execution', run.id]);
  const back = (await a.get(`/api/executions/${run.id}`)).data;
  assert.equal(back.cycle_id, cy.id);
  assert.equal(back.steps[0].status, 'Fail');
  assert.equal(back.steps[0].attachments.length, 1);
  assert.equal(back.comments.length, 1);
  assert.equal((await a.get(`/api/bugs/${bug.id}`)).data.execution_id, run.id, 'and the bug points at it again');
  // restoring into a cycle that is gone fails clearly instead of corrupting anything
  await a.ok('DELETE', `/api/executions/${run.id}`);
  await a.ok('DELETE', `/api/cycles/${cy.id}`);
  const orphan = (await trash()).find((x) => x.kind === 'execution');
  assert.equal((await a.post(`/api/trash/${orphan.id}/restore`, {})).status, 409);
});
