'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a;
before(async () => { ctx = await startAdmin(); a = ctx.admin; });
after(() => ctx.server.stop());

const cycle = async (name, extra = {}) => (await a.post('/api/projects/1/cycles', { name, caseIds: [1, 2, 3], ...extra })).data;
async function pass(cycleId, nCases) {
  const ex = (await a.get(`/api/cycles/${cycleId}`)).data.executions.slice(0, nCases);
  for (const e of ex) for (const s of (await a.get(`/api/executions/${e.id}`)).data.steps) await a.ok('PUT', `/api/step-results/${s.id}`, { status: 'Pass' });
}

test('plans get P-keys and roll up their cycles', async () => {
  const p1 = (await a.post('/api/projects/1/plans', { name: 'Release 2.0', description: 'Everything for 2.0' })).data;
  const p2 = (await a.post('/api/projects/1/plans', { name: 'Hotfix' })).data;
  assert.equal(p1.key, 'DEMO-P1');
  assert.equal(p2.key, 'DEMO-P2');
  assert.equal((await a.post('/api/projects/1/plans', { name: '  ' })).status, 400);
  const c1 = await cycle('Smoke', { plan_id: p1.id });
  const c2 = await cycle('Regression');
  await pass(c1.id, 3);
  await pass(c2.id, 1);
  assert.equal((await a.post(`/api/plans/${p1.id}/cycles`, { cycleIds: [c2.id] })).data.added, 1);
  const plan = (await a.get(`/api/plans/${p1.id}`)).data;
  assert.equal(plan.cycles, 2);
  assert.equal(plan.total, 6);
  assert.equal(plan.pass, 4);
  assert.equal(plan.not_executed, 2);
  assert.deepEqual(plan.cycleList.map((c) => c.name), ['Smoke', 'Regression']);
  assert.ok(!plan.available.some((c) => [c1.id, c2.id].includes(c.id)), 'planned cycles are not offered again');
  assert.ok(plan.available.some((c) => c.name === 'Release 1.0 smoke test'), 'unplanned seed cycle is offered');
  const list = (await a.get('/api/projects/1/plans')).data;
  assert.deepEqual(list.map((p) => [p.key, p.cycles, p.total]), [['DEMO-P2', 0, 0], ['DEMO-P1', 2, 6]]);
});

test('cycles show their plan; plans can be changed, cleared and edited', async () => {
  const p = (await a.post('/api/projects/1/plans', { name: 'Moves' })).data;
  const c = await cycle('Movable');
  assert.equal((await a.get(`/api/cycles/${c.id}`)).data.plan_id, null);
  await a.ok('PUT', `/api/cycles/${c.id}`, { plan_id: p.id, name: 'Movable (renamed)', build: '9.9', environment: 'Prod' });
  const got = (await a.get(`/api/cycles/${c.id}`)).data;
  assert.deepEqual([got.plan_key, got.plan_name, got.name, got.build, got.environment], [p.key, 'Moves', 'Movable (renamed)', '9.9', 'Prod']);
  const listed = (await a.get('/api/projects/1/cycles')).data.find((x) => x.id === c.id);
  assert.equal(listed.plan_key, p.key);
  await a.ok('PUT', `/api/cycles/${c.id}`, { name: 'Only the name' });
  assert.equal((await a.get(`/api/cycles/${c.id}`)).data.plan_id, p.id, 'a PUT without plan_id leaves the plan alone');
  await a.ok('PUT', `/api/cycles/${c.id}`, { plan_id: null });
  assert.equal((await a.get(`/api/cycles/${c.id}`)).data.plan_id, null);
  await a.ok('PUT', `/api/plans/${p.id}`, { name: 'Renamed plan', description: 'd' });
  assert.equal((await a.get(`/api/plans/${p.id}`)).data.name, 'Renamed plan');
  assert.equal((await a.put(`/api/plans/${p.id}`, { name: '' })).status, 400);
  assert.equal((await a.put(`/api/cycles/${c.id}`, { name: ' ' })).status, 400);
});

test('plan rules: same project only, no standalone runs, clone keeps the plan, delete unplans', async () => {
  const other = (await a.post('/api/projects', { name: 'Other', key: 'OTH' })).data;
  const foreign = (await a.post(`/api/projects/${other.id}/plans`, { name: 'Foreign plan' })).data;
  const c = await cycle('Rules');
  assert.equal((await a.put(`/api/cycles/${c.id}`, { plan_id: foreign.id })).status, 400, 'plan from another project');
  assert.equal((await a.put(`/api/cycles/${c.id}`, { plan_id: 999 })).status, 400);
  assert.equal((await a.post('/api/projects/1/cycles', { name: 'x', plan_id: foreign.id })).status, 400);
  assert.equal((await a.post(`/api/plans/${foreign.id}/cycles`, { cycleIds: [c.id] })).data.added, 0, 'cannot adopt a cycle from another project');
  const run = (await a.post('/api/cases/1/run')).data;
  const adhoc = (await a.get(`/api/executions/${run.executionId}`)).data.cycle_id;
  const plan = (await a.post('/api/projects/1/plans', { name: 'Clone plan' })).data;
  assert.equal((await a.put(`/api/cycles/${adhoc}`, { plan_id: plan.id })).status, 400, 'standalone runs cannot be planned');
  assert.equal((await a.post(`/api/plans/${plan.id}/cycles`, { cycleIds: [adhoc] })).data.added, 0);
  await a.ok('PUT', `/api/cycles/${c.id}`, { plan_id: plan.id });
  const clone = (await a.post(`/api/cycles/${c.id}/clone`, { include: 'all' })).data;
  assert.equal((await a.get(`/api/cycles/${clone.id}`)).data.plan_id, plan.id, 'a clone stays in the plan');
  const loose = (await a.post(`/api/cycles/${c.id}/clone`, { include: 'all', plan_id: null })).data;
  assert.equal((await a.get(`/api/cycles/${loose.id}`)).data.plan_id, null, 'or can be cloned out of it');
  assert.equal((await a.post(`/api/plans/${plan.id}/cycles`, { cycleIds: [] })).status, 400);
  await a.ok('DELETE', `/api/plans/${plan.id}`);
  assert.equal((await a.get(`/api/cycles/${c.id}`)).data.plan_id, null, 'cycles survive their plan');
  assert.equal((await a.get(`/api/plans/${plan.id}`)).status, 404);
});

test('plan export, permissions', async () => {
  const p = (await a.post('/api/projects/1/plans', { name: 'Exportable' })).data;
  await cycle('In plan', { plan_id: p.id });
  const csv = (await a.get(`/api/plans/${p.id}/export?format=csv`)).data.toString('utf8').split('\r\n').filter(Boolean);
  assert.equal(csv[0], '﻿Cycle,Name,Build,Environment,Total,Pass,Fail,Blocked,Not run,Pass rate');
  assert.ok(csv[1].includes('In plan'));
  const viewer = await addUser(ctx.server, a, 'vic', 'viewer');
  assert.equal((await viewer.client.get(`/api/plans/${p.id}`)).status, 200);
  assert.equal((await viewer.client.post('/api/projects/1/plans', { name: 'No' })).status, 403);
  assert.equal((await viewer.client.del(`/api/plans/${p.id}`)).status, 403);
  assert.equal((await viewer.client.put(`/api/cycles/1`, { name: 'No' })).status, 403);
});
