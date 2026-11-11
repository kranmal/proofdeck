'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin } = require('./helpers');

let ctx, a;
before(async () => { ctx = await startAdmin(); a = ctx.admin; });
after(() => ctx.server.stop());

const mk = async (title, steps = [], extra = {}) => (await a.post('/api/projects/1/cases', { title, steps, ...extra })).data;
const cycleOf = async (caseIds, name = 'Reuse') => (await a.post('/api/projects/1/cycles', { name, caseIds })).data;
const execs = async (cycleId) => (await a.get(`/api/cycles/${cycleId}`)).data.executions;
const stepsOf = async (execId) => (await a.get(`/api/executions/${execId}`)).data.steps;

test('a call step runs the called case inline, tagged with its key; nested calls expand', async () => {
  const login = await mk('Log in', [{ action: 'Open /login', expected: 'Form' }, { action: 'Submit credentials', expected: 'Dashboard' }]);
  const setup = await mk('Set up account', [{ action: 'Create account', expected: 'Created' }, { call_case_id: login.id }]);
  const main = await mk('Checkout', [{ call_case_id: setup.id }, { action: 'Pay', expected: 'Paid' }]);
  const c = await a.get(`/api/cases/${main.id}`);
  assert.equal(c.data.steps[0].call_key, setup.key);
  assert.equal(c.data.steps[0].call_title, 'Set up account');
  assert.equal(c.data.steps[0].call_steps, 2);
  assert.deepEqual((await a.get(`/api/cases/${login.id}`)).data.usedBy.map((u) => u.key), [setup.key]);
  const cyc = await cycleOf([main.id]);
  const [ex] = await execs(cyc.id);
  const steps = await stepsOf(ex.id);
  assert.deepEqual(steps.map((s) => [s.position, s.action, s.origin]), [
    [1, 'Create account', setup.key], [2, 'Open /login', login.key], [3, 'Submit credentials', login.key], [4, 'Pay', ''],
  ]);
});

test('calls cannot form loops, point outside the project, or at nothing', async () => {
  const x = await mk('X'), y = await mk('Y', [{ call_case_id: x.id }]);
  assert.equal((await a.put(`/api/cases/${x.id}`, { steps: [{ call_case_id: y.id }] })).status, 400, 'x -> y -> x');
  assert.equal((await a.put(`/api/cases/${x.id}`, { steps: [{ call_case_id: x.id }] })).status, 400, 'self call');
  assert.equal((await a.put(`/api/cases/${x.id}`, { steps: [{ call_case_id: 9999 }] })).status, 400, 'missing');
  const other = (await a.post('/api/projects', { name: 'Other', key: 'OTH' })).data;
  const foreign = (await a.post(`/api/projects/${other.id}/cases`, { title: 'Foreign' })).data;
  assert.equal((await a.put(`/api/cases/${x.id}`, { steps: [{ call_case_id: foreign.id }] })).status, 400, 'other project');
  assert.equal((await a.get(`/api/cases/${x.id}`)).data.steps.length, 0, 'a refused save changes nothing');
  assert.equal((await a.post('/api/projects/1/cases', { title: 'Bad', steps: [{ call_case_id: 9999 }] })).status, 400);
});

test('runs are snapshots: editing the called case later does not change old runs', async () => {
  const lib = await mk('Shared', [{ action: 'old step', expected: 'old' }]);
  const user = await mk('Uses shared', [{ call_case_id: lib.id }]);
  const first = await cycleOf([user.id], 'before');
  await a.ok('PUT', `/api/cases/${lib.id}`, { steps: [{ action: 'new step', expected: 'new' }, { action: 'extra', expected: 'x' }] });
  const second = await cycleOf([user.id], 'after');
  assert.deepEqual((await stepsOf((await execs(first.id))[0].id)).map((s) => s.action), ['old step']);
  assert.deepEqual((await stepsOf((await execs(second.id))[0].id)).map((s) => s.action), ['new step', 'extra']);
  const re = (await a.post(`/api/cycles/${first.id}/clone`, { include: 'all' })).data;
  assert.deepEqual((await stepsOf((await execs(re.id))[0].id)).map((s) => s.action), ['new step', 'extra'], 'a clone picks up the latest steps');
});

test('deleting a called case removes the call, renumbers the caller and records why', async () => {
  const gone = await mk('Doomed helper', [{ action: 'h', expected: 'h' }]);
  const caller = await mk('Caller', [{ action: 'first', expected: 'f' }, { call_case_id: gone.id }, { action: 'last', expected: 'l' }]);
  await a.ok('DELETE', `/api/cases/${gone.id}`);
  const c = (await a.get(`/api/cases/${caller.id}`)).data;
  assert.deepEqual(c.steps.map((s) => [s.position, s.action]), [[1, 'first'], [2, 'last']]);
  const vs = (await a.get(`/api/cases/${caller.id}/versions`)).data;
  assert.match(vs[0].note, /Step calling .* removed because .* was deleted/);
  const helper = await mk('Helper 2', [{ action: 'h', expected: 'h' }]);
  const c2 = await mk('Caller 2', [{ call_case_id: helper.id }]);
  assert.equal((await a.post('/api/projects/1/cases/bulk', { ids: [helper.id], action: 'delete' })).data.count, 1);
  assert.equal((await a.get(`/api/cases/${c2.id}`)).data.steps.length, 0, 'bulk delete cleans up calls too');
});

test('data sets: validation, one execution per row, placeholders substituted', async () => {
  const bad = (params) => a.post('/api/projects/1/cases', { title: 'Bad data', params });
  assert.equal((await bad({ columns: ['1bad'], rows: [] })).status, 400);
  assert.equal((await bad({ columns: ['a', 'A'], rows: [] })).status, 400, 'duplicate columns');
  assert.equal((await bad({ columns: ['a'], rows: Array(201).fill(['x']) })).status, 400);
  assert.equal((await bad({ columns: Array.from({ length: 21 }, (_, i) => `c${i}`), rows: [] })).status, 400);
  assert.equal((await bad('nonsense')).status, 400);

  const login = await mk('Parameterised login', [
    { action: 'Enter {{email}} and {{ password }}', test_data: 'user {{email}}', expected: 'Welcome {{Email}}, {{unknown}} stays' },
  ], { precondition: 'Account {{email}} exists', params: { columns: ['email', 'password', 'role'], rows: [['a@x.io', 'pw1', 'admin'], ['b@x.io', 'pw2', 'viewer'], ['', '', ''], ['c@x.io', 'pw3', 'tester']] } });
  const got = (await a.get(`/api/cases/${login.id}`)).data;
  assert.deepEqual(got.params.columns, ['email', 'password', 'role']);
  assert.equal(got.params.rows.length, 3, 'blank rows are dropped');
  const cyc = await cycleOf([login.id]);
  const list = await execs(cyc.id);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((e) => e.iteration), [1, 2, 3]);
  assert.equal(list[0].iteration_label, 'email=a@x.io; password=pw1; role=admin');
  const full = (await a.get(`/api/executions/${list[1].id}`)).data;
  assert.equal(full.precondition, 'Account b@x.io exists');
  assert.equal(full.steps[0].action, 'Enter b@x.io and pw2');
  assert.equal(full.steps[0].test_data, 'user b@x.io');
  assert.equal(full.steps[0].expected, 'Welcome b@x.io, {{unknown}} stays', 'case-insensitive names; unknown placeholders are left alone');
  assert.equal(full.prev, list[0].id);
  assert.equal(full.next, list[2].id);
  assert.equal((await a.post(`/api/cycles/${cyc.id}/cases`, { caseIds: [login.id] })).data.added, 0, 'cannot add the same case twice');
  assert.equal((await execs(cyc.id)).length, 3);
});

test('standalone runs of a data-set case create all iterations that are neighbours of each other', async () => {
  const c = await mk('Data run', [{ action: 'Use {{v}}', expected: 'ok' }], { params: { columns: ['v'], rows: [['one'], ['two']] } });
  const run = (await a.post(`/api/cases/${c.id}/run`)).data;
  assert.equal(run.executionIds.length, 2);
  const first = (await a.get(`/api/executions/${run.executionIds[0]}`)).data;
  assert.equal(first.next, run.executionIds[1]);
  assert.equal(first.prev, null);
  const second = (await a.get(`/api/executions/${run.executionIds[1]}`)).data;
  assert.equal(second.prev, run.executionIds[0]);
  assert.equal(second.steps[0].action, 'Use two');
  const again = (await a.post(`/api/cases/${c.id}/run`)).data;
  const other = (await a.get(`/api/executions/${again.executionIds[0]}`)).data;
  assert.ok(![other.prev, other.next].includes(run.executionIds[1]), 'a separate run is not a neighbour');
  const plain = (await a.post('/api/cases/1/run')).data;
  assert.equal(plain.executionIds.length, 1);
  assert.equal((await a.get(`/api/executions/${plain.executionId}`)).data.next, null);
});

test('cloning a cycle re-creates only the failed iterations, from the same rows', async () => {
  const c = await mk('Clone data', [{ action: 'Use {{v}}', expected: 'ok' }], { params: { columns: ['v'], rows: [['one'], ['two'], ['three']] } });
  const cyc = await cycleOf([c.id], 'Data cycle');
  const list = await execs(cyc.id);
  for (const [i, e] of list.entries()) for (const s of await stepsOf(e.id)) await a.ok('PUT', `/api/step-results/${s.id}`, { status: i === 1 ? 'Fail' : 'Pass' });
  const failed = (await a.post(`/api/cycles/${cyc.id}/clone`, { include: 'failed' })).data;
  assert.equal(failed.added, 1);
  const [only] = await execs(failed.id);
  assert.equal(only.iteration, 2);
  assert.equal(only.iteration_label, 'v=two');
  assert.equal((await stepsOf(only.id))[0].action, 'Use two');
  const all = (await a.post(`/api/cycles/${cyc.id}/clone`, { include: 'all' })).data;
  assert.equal(all.added, 3);
  await a.ok('PUT', `/api/cases/${c.id}`, { params: { columns: ['v'], rows: [['x']] } });
  const shrunk = (await a.post(`/api/cycles/${cyc.id}/clone`, { include: 'all' })).data;
  assert.equal(shrunk.added, 1, 'rows that no longer exist are not invented');
});

test('versions capture call steps and data sets, and restoring handles deleted targets', async () => {
  const helper = await mk('Helper');
  const c = await mk('Versioned reuse', [{ action: 'plain', expected: 'p' }]);
  await a.ok('PUT', `/api/cases/${c.id}`, { steps: [{ action: 'plain', expected: 'p' }, { call_case_id: helper.id }], params: { columns: ['k'], rows: [['1']] } });
  const v2 = (await a.get(`/api/cases/${c.id}/versions/2`)).data.snapshot;
  assert.deepEqual(v2.steps[1], { call_case_id: helper.id });
  assert.equal(JSON.parse(v2.params).rows.length, 1);
  await a.ok('PUT', `/api/cases/${c.id}`, { steps: [{ action: 'plain', expected: 'p' }], params: null });
  assert.equal((await a.get(`/api/cases/${c.id}`)).data.params.columns.length, 0, 'null clears the data set');
  assert.equal((await a.post(`/api/cases/${c.id}/versions/2/restore`)).status, 200);
  const back = (await a.get(`/api/cases/${c.id}`)).data;
  assert.equal(back.steps[1].call_case_id, helper.id);
  assert.deepEqual(back.params.rows, [['1']]);
  // restore after the helper is gone: the call is dropped, everything else returns
  await a.ok('PUT', `/api/cases/${c.id}`, { title: 'Versioned reuse (changed)' });
  await a.ok('DELETE', `/api/cases/${helper.id}`);
  assert.equal((await a.post(`/api/cases/${c.id}/versions/2/restore`)).status, 200);
  assert.equal((await a.get(`/api/cases/${c.id}`)).data.steps.length, 1);
});

test('clone keeps calls and data sets; export spells calls out in words', async () => {
  const lib = await mk('Lib', [{ action: 'lib step', expected: 'x' }]);
  const src = await mk('Source', [{ call_case_id: lib.id }, { action: 'own', expected: 'y' }], { params: { columns: ['k'], rows: [['1'], ['2']] } });
  const copy = (await a.post(`/api/cases/${src.id}/clone`)).data;
  const c = (await a.get(`/api/cases/${copy.id}`)).data;
  assert.equal(c.steps[0].call_case_id, lib.id);
  assert.equal(c.params.rows.length, 2);
  const csv = (await a.get(`/api/projects/1/export?format=csv&ids=${src.id}`)).data.toString('utf8');
  assert.ok(csv.includes(`Call test case ${lib.key}: Lib`));
});
