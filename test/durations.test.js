'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin } = require('./helpers');

let ctx, a, token;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  token = (await a.ok('POST', '/api/projects/1/api-tokens', { name: 'CI' })).token;
});
after(() => ctx.server.stop());

const send = (url, body, type = 'application/json') => fetch(ctx.server.base + url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const results = (list, build = 'b1') => send('/api/ci/results', { cycle: { name: 'Timed', build }, autoCreate: true, results: list });

test('CI durations are stored per run, bad values are ignored, huge ones are capped', async () => {
  const r = await (await results([
    { automation_key: 'perf::fast', title: 'Fast', status: 'Pass', duration_ms: 120 },
    { automation_key: 'perf::slow', title: 'Slow', status: 'Pass', duration_ms: 95000 },
    { automation_key: 'perf::weird', title: 'Weird', status: 'Pass', duration_ms: 'abc' },
    { automation_key: 'perf::neg', title: 'Negative', status: 'Pass', duration_ms: -5 },
    { automation_key: 'perf::huge', title: 'Huge', status: 'Pass', duration_ms: 9e15 },
    { automation_key: 'perf::none', title: 'None', status: 'Pass' },
  ])).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  const cyc = (await a.get(`/api/cycles/${r.cycle.id}`)).data;
  const by = Object.fromEntries(cyc.executions.map((e) => [e.case_title, e.duration_ms]));
  assert.equal(by.Fast, 120);
  assert.equal(by.Slow, 95000);
  assert.equal(by.Weird, null);
  assert.equal(by.Negative, null);
  assert.equal(by.Huge, 7 * 86400000);
  assert.equal(by.None, null);
});

test('JUnit reports bring their timings along', async () => {
  const xml = `<testsuite><testcase classname="suite.a" name="parses" time="1.5"/><testcase classname="suite.a" name="renders" time="0.25"><failure message="boom"/></testcase></testsuite>`;
  const r = await (await send('/api/ci/junit?cycle=JUnit&build=1&autoCreate=1', xml, 'application/xml')).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  const cyc = (await a.get(`/api/cycles/${r.cycle.id}`)).data;
  assert.deepEqual(cyc.executions.map((e) => e.duration_ms).sort((x, y) => x - y), [250, 1500]);
});

test('the case page shows reliability and average time, and a re-run updates the time', async () => {
  const id = (await a.get('/api/projects/1/cases')).data.find((c) => c.title === 'Slow').id;
  // pass, fail, pass, fail: three switches
  for (const [i, st] of ['Pass', 'Fail', 'Pass', 'Fail'].entries()) {
    await (await results([{ automation_key: 'perf::slow', status: st, duration_ms: (i + 1) * 1000 }], `r${i}`)).json();
  }
  const c = (await a.get(`/api/cases/${id}`)).data;
  assert.equal(c.runStats.runs, 5);
  assert.equal(c.runStats.fails, 2);
  assert.equal(c.runStats.switches, 3);
  assert.equal(c.runStats.avg_ms, Math.round((95000 + 1000 + 2000 + 3000 + 4000) / 5));
  assert.equal(c.runs[0].duration_ms, 4000);
  // re-sending the same cycle replaces the time
  await results([{ automation_key: 'perf::slow', status: 'Fail', duration_ms: 4500 }], 'r3');
  assert.equal((await a.get(`/api/cases/${id}`)).data.runs[0].duration_ms, 4500);
});

test('the reports list the slowest tests, honouring filters', async () => {
  const r = (await a.get('/api/projects/1/reports')).data;
  assert.deepEqual(r.slowest.map((x) => x.avg_ms), [...r.slowest.map((x) => x.avg_ms)].sort((x, y) => y - x), 'slowest first');
  assert.ok(r.slowest.some((x) => x.title === 'Slow' && x.runs === 5 && x.max_ms === 95000));
  assert.ok(r.slowest.every((x) => x.avg_ms > 0 && x.runs >= 1));
  assert.ok(!r.slowest.some((x) => x.title === 'None'), 'untimed tests are left out');
  const none = (await a.get('/api/projects/1/reports?label=no-such-label')).data;
  assert.deepEqual(none.slowest, []);
  const future = (await a.get('/api/projects/1/reports?from=2999-01-01')).data;
  assert.deepEqual(future.slowest, []);
});
