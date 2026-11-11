'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
});
after(() => ctx.server.stop());

// Run case `caseId` in a fresh cycle and give it `status` (Pass/Fail) on every step.
async function runIn(name, caseId, status, extra = {}) {
  const c = (await a.post('/api/projects/1/cycles', { name, build: name, caseIds: [caseId], ...extra })).data;
  const ex = (await a.get(`/api/cycles/${c.id}`)).data.executions[0];
  const steps = (await a.get(`/api/executions/${ex.id}`)).data.steps;
  if (status) for (const s of steps) await a.ok('PUT', `/api/step-results/${s.id}`, { status, actual: status === 'Fail' ? 'boom' : '' });
  return { cycle: c.id, exec: ex.id, steps };
}

test('trend lists planned cycles oldest first with counts; standalone runs are excluded', async () => {
  await runIn('R1', 1, 'Pass');
  await runIn('R2', 1, 'Fail');
  const mixed = (await a.post('/api/projects/1/cycles', { name: 'R3 mixed', caseIds: [1, 2, 3] })).data;
  const ex = (await a.get(`/api/cycles/${mixed.id}`)).data.executions;
  for (const s of (await a.get(`/api/executions/${ex[0].id}`)).data.steps) await a.ok('PUT', `/api/step-results/${s.id}`, { status: 'Pass' });
  await a.ok('PUT', `/api/step-results/${(await a.get(`/api/executions/${ex[1].id}`)).data.steps[0].id}`, { status: 'Blocked' });
  await a.post('/api/cases/2/run');
  const r = (await a.get('/api/projects/1/reports')).data;
  const names = r.trend.map((c) => c.name);
  assert.ok(names.indexOf('R1') < names.indexOf('R2') && names.indexOf('R2') < names.indexOf('R3 mixed'), 'oldest first');
  assert.ok(!names.includes('Standalone runs'));
  const last = r.trend.at(-1);
  assert.deepEqual([last.total, last.pass, last.blocked, last.not_executed], [3, 1, 1, 1]);
  assert.equal(r.trend.find((c) => c.name === 'R2').fail, 1);
  assert.equal((await a.get('/api/projects/1/reports?cycles=3')).data.trend.length, 3);
  assert.equal((await a.get('/api/projects/1/reports?cycles=1')).data.trend.length <= 30, true, 'limit is clamped');
});

test('failing and flaky: counts fails and pass/fail flips per case over time', async () => {
  for (const [i, st] of ['Pass', 'Fail', 'Pass', 'Fail'].entries()) await runIn(`F${i}`, 2, st);
  const r = (await a.get('/api/projects/1/reports')).data;
  const c2 = r.failing.find((f) => f.key === 'DEMO-T2');
  assert.equal(c2.fails, 2);
  assert.equal(c2.runs, 4);
  assert.equal(c2.flips, 3);
  assert.equal(c2.last, 'Fail');
  assert.ok(r.flaky.some((f) => f.key === 'DEMO-T2' && f.flips === 3), 'three flips is flaky');
  assert.equal(r.flaky.find((f) => f.key === 'DEMO-T1').flips, 2, 'T1 went pass, fail, pass');
  assert.ok(!r.flaky.some((f) => f.key === 'DEMO-T3'), 'never-failed cases are not flaky');
  assert.equal(r.failing[0].key, 'DEMO-T2', 'most failures first');
});

test('coverage counts the last result of each non-deprecated case, including never run', async () => {
  const made = (await a.post('/api/projects/1/cases', { title: 'Never run case' })).data;
  const dep = (await a.post('/api/projects/1/cases', { title: 'Old one', status: 'Deprecated' })).data;
  assert.ok(made.id && dep.id);
  const r = (await a.get('/api/projects/1/reports')).data;
  const total = Object.values(r.coverage).reduce((n, x) => n + x, 0);
  assert.equal(total, (await a.get('/api/projects/1/cases')).data.filter((c) => c.status !== 'Deprecated').length);
  assert.equal(r.coverage['Never run'], 2, 'DEMO-T3 and the new case');
  assert.equal(r.coverage.Fail, 1, 'T2 last failed');
  assert.equal(r.coverage.Pass, 0 + (r.coverage.Pass), 'present');
});

test('bug stats: open by severity, average age, bugs per case', async () => {
  const { steps } = await runIn('B1', 1, 'Fail');
  const b1 = (await a.post(`/api/step-results/${steps[0].id}/bug`, { severity: 'Critical' })).data;
  const b2 = (await a.post(`/api/step-results/${steps[1].id}/bug`, { severity: 'Minor' })).data;
  await a.ok('POST', '/api/projects/1/bugs', { title: 'Manual', severity: 'Minor' });
  await a.ok('PUT', `/api/bugs/${b2.id}`, { status: 'Closed' });
  const r = (await a.get('/api/projects/1/reports')).data;
  assert.equal(r.bugs.total, 3);
  assert.equal(r.bugs.open, 2);
  const sev = Object.fromEntries(r.bugs.openBySeverity.map((x) => [x.severity, x.count]));
  assert.deepEqual(sev, { Critical: 1, Major: 0, Minor: 1, Trivial: 0 });
  assert.ok(r.bugs.avgOpenAgeDays >= 0 && r.bugs.avgOpenAgeDays < 1);
  assert.deepEqual(r.bugs.byCase[0], { case_key: 'DEMO-T1', case_id: 1, count: 2, open: 1 });
  assert.ok(b1.id);
});

test('activity shows who executed what in the last 30 days', async () => {
  const tess = await addUser(ctx.server, a, 'tess', 'tester');
  const c = (await tess.client.post('/api/projects/1/cycles', { name: 'Tess run', caseIds: [3] })).data;
  const ex = (await tess.client.get(`/api/cycles/${c.id}`)).data.executions[0];
  const steps = (await tess.client.get(`/api/executions/${ex.id}`)).data.steps;
  for (const s of steps) await tess.client.ok('PUT', `/api/step-results/${s.id}`, { status: 'Pass' });
  const r = (await a.get('/api/projects/1/reports')).data;
  const mine = r.activity.find((x) => x.name === 'TESS');
  assert.deepEqual([mine.executed, mine.pass, mine.fail], [1, 1, 0]);
  assert.ok(r.activity.find((x) => x.name === 'Ada Admin').executed >= 5);
});

test('trend export is a CSV/XLSX with a pass rate', async () => {
  const csv = (await a.get('/api/projects/1/reports/export?format=csv&cycles=5')).data.toString('utf8');
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines[0], '﻿Cycle,Name,Build,Environment,Created,Total,Pass,Fail,Blocked,Not run,Pass rate');
  assert.ok(lines.length >= 2 && /\d+%|,$/.test(lines[1]));
  const x = await a.get('/api/projects/1/reports/export?format=xlsx');
  assert.equal(x.data.subarray(0, 2).toString(), 'PK');
  assert.equal((await a.get('/api/projects/1/reports/export?format=pdf')).status, 400);
  assert.equal((await a.get('/api/projects/99/reports')).status, 404);
});
