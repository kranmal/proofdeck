'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin } = require('./helpers');

let server, admin;
before(async () => { ({ server, admin } = await startAdmin()); });
after(() => server.stop());

const b64 = (s) => Buffer.from(s).toString('base64');

test('the bug-from-failed-step flow carries expected, actual, screenshots and edited repro steps', async () => {
  const ex = (await admin.get('/api/executions/2')).data;
  assert.equal(ex.steps.length, 3);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const step = ex.steps[1];
  await admin.ok('PUT', `/api/step-results/${step.id}`, { status: 'Fail', actual: 'Cart badge stays at 0' });
  await admin.ok('POST', `/api/step-results/${step.id}/attachments`, { filename: 'shot.png', mime: 'image/png', data: png });
  assert.equal((await admin.post(`/api/step-results/${step.id}/attachments`, { filename: 'x.svg', mime: 'image/svg+xml', data: b64('<svg/>') })).status, 400, 'svg is not accepted');
  const bug = await admin.ok('POST', `/api/step-results/${step.id}/bug`, { title: 'Badge not updated', steps_to_reproduce: '1. Add to cart' });
  const b = (await admin.get(`/api/bugs/${bug.id}`)).data;
  assert.equal(b.expected, 'Cart badge shows 1');
  assert.equal(b.actual, 'Cart badge stays at 0');
  assert.equal(b.steps_to_reproduce, '1. Add to cart');
  assert.equal(b.case_key, 'DEMO-T2');
  assert.equal(b.step_no, 2);
  assert.equal(b.attachments.length, 1, 'screenshot is copied to the bug');
  assert.equal((await admin.get(`/api/attachments/${b.attachments[0].id}`)).headers.get('content-type'), 'image/png');
  assert.equal((await admin.get('/api/executions/2')).data.status, 'Fail', 'execution status follows its steps');
});

test('importing: CSV with quotes, multi-line cells, blank-title continuation rows and a semicolon file', async () => {
  const csv = '﻿Key,Name,Status,Folder,Priority,Test Script - Step,Test Script - Test Data,Test Script - Expected Result\r\n'
    + 'Z-1,Login,Approved,/Auth/Login,High,Open page,/login,"Form shown\nwith fields"\r\n'
    + ',,,,,Submit,"user ""bob""",Dashboard\r\n'
    + 'Z-2,Logout,Weird,,Normal,Click logout,,Out\r\n';
  const parsed = (await admin.post('/api/import/parse', { data: b64(csv) })).data;
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.mapping.action, 5);
  const dry = (await admin.post('/api/projects/1/import', { rows: parsed.rows, mapping: parsed.mapping, dryRun: true })).data;
  assert.equal(dry.cases, 2);
  assert.equal(dry.steps, 3);
  const done = (await admin.post('/api/projects/1/import', { rows: parsed.rows, mapping: parsed.mapping })).data;
  const all = (await admin.get('/api/projects/1/cases')).data;
  const login = (await admin.get(`/api/cases/${all.find((c) => c.title === 'Login').id}`)).data;
  assert.equal(login.folder, 'Auth/Login');
  assert.equal(login.priority, 'High');
  assert.equal(login.steps[0].expected, 'Form shown\nwith fields');
  assert.equal(login.steps[1].test_data, 'user "bob"');
  assert.equal(all.find((c) => c.title === 'Logout').status, 'Draft', 'unknown status falls back to Draft');
  assert.ok(done.firstKey);
  const semi = (await admin.post('/api/import/parse', { data: b64('Title;Steps;Expected\nA;do;ok\n;do2;ok2\n') })).data;
  assert.deepEqual(semi.mapping, { title: 0, action: 1, expected: 2 });
  assert.equal((await admin.post('/api/projects/1/import', { rows: semi.rows, mapping: {}, dryRun: true })).status, 400, 'title column is required');
  assert.equal((await admin.post('/api/import/parse', { data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]).toString('base64') })).status, 400, 'old .xls is refused clearly');
});

test('export round-trips through import for CSV and XLSX, and defuses formulas in CSV', async () => {
  const made = (await admin.post('/api/projects/1/cases', {
    title: '=SUM(A1) "quoted", title', folder: ' Pay / Cards ', objective: 'multi\nline',
    steps: [{ action: '-5 apples', test_data: '@user', expected: 'Ünïcode ✓ <b>&amp;</b>' }, { action: 'second', expected: 'ok' }],
  })).data;
  assert.equal((await admin.get(`/api/cases/${made.id}`)).data.folder, 'Pay/Cards');
  for (const format of ['csv', 'xlsx']) {
    const res = await admin.get(`/api/projects/1/export?format=${format}&ids=${made.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), new RegExp(`filename="DEMO-test-cases-\\d{4}-\\d{2}-\\d{2}\\.${format}"`));
    if (format === 'csv') {
      const text = res.data.toString('utf8');
      assert.ok(text.startsWith('﻿ID,Name,'));
      assert.ok(text.includes(`'=SUM(A1)`) && text.includes("'-5 apples") && text.includes("'@user"), 'formula-looking cells are prefixed');
    } else assert.equal(res.data.subarray(0, 2).toString(), 'PK');
    const parsed = (await admin.post('/api/import/parse', { data: res.data.toString('base64') })).data;
    await admin.ok('POST', '/api/projects/1/import', { rows: parsed.rows, mapping: parsed.mapping });
  }
  const copies = (await admin.get('/api/projects/1/cases')).data.filter((c) => c.title.startsWith('=SUM'));
  assert.equal(copies.length, 3);
  for (const c of copies.slice(1)) {
    const full = (await admin.get(`/api/cases/${c.id}`)).data;
    assert.equal(full.title, '=SUM(A1) "quoted", title');
    assert.equal(full.steps[0].action, '-5 apples');
    assert.equal(full.steps[0].test_data, '@user');
    assert.equal(full.steps[0].expected, 'Ünïcode ✓ <b>&amp;</b>');
    assert.equal(full.objective, 'multi\nline');
    assert.equal(full.folder, 'Pay/Cards');
  }
  assert.equal((await admin.get('/api/projects/1/export?format=exe')).status, 400);
  const none = (await admin.get('/api/projects/1/export?format=csv&ids=')).data.toString('utf8');
  assert.ok(none.trim().split('\r\n').length > 3, 'an empty ids parameter means "everything", not "nothing"');
});

test('folders: implied ancestors, rename moves the subtree, delete lifts contents, nothing is lost', async () => {
  const folders = async () => (await admin.get('/api/projects/1/folders')).data;
  assert.ok((await folders()).includes('Pay') && (await folders()).includes('Pay/Cards'));
  assert.equal((await admin.post('/api/projects/1/folders', { path: 'Empty / Sub' })).data.path, 'Empty/Sub');
  assert.ok((await folders()).includes('Empty'));
  await admin.ok('POST', '/api/projects/1/folders/rename', { from: 'Pay', to: 'Billing' });
  assert.ok((await folders()).includes('Billing/Cards') && !(await folders()).some((f) => f.startsWith('Pay')));
  assert.equal((await admin.post('/api/projects/1/folders/rename', { from: 'Billing', to: 'Billing/Cards/X' })).status, 400);
  assert.equal((await admin.post('/api/projects/1/folders/rename', { from: 'Nope', to: 'X' })).status, 404);
  const before = (await admin.get('/api/projects/1/cases')).data.length;
  await admin.ok('POST', '/api/projects/1/folders/delete', { path: 'Billing' });
  assert.ok((await folders()).includes('Cards') && !(await folders()).includes('Billing'));
  assert.equal((await admin.get('/api/projects/1/cases')).data.length, before);
  const ids = (await admin.get('/api/projects/1/cases')).data.slice(0, 3).map((c) => c.id);
  assert.equal((await admin.post('/api/projects/1/cases/bulk', { ids, action: 'move', folder: 'Moved / Here' })).data.count, 3);
  assert.equal((await admin.post('/api/projects/1/cases/bulk', { ids: [], action: 'move' })).status, 400);
  assert.equal((await admin.post('/api/projects/1/cases/bulk', { ids, action: 'zap' })).status, 400);
});

test('cycles: clone keeps only what was asked for with clean results; standalone runs are separate', async () => {
  const cycle = (await admin.post('/api/projects/1/cycles', { name: 'Clone me', environment: 'Stage', build: '1', caseIds: [1, 2, 3] })).data;
  const ex = (await admin.get(`/api/cycles/${cycle.id}`)).data.executions;
  const steps = async (e) => (await admin.get(`/api/executions/${e.id}`)).data.steps;
  for (const s of await steps(ex[0])) await admin.ok('PUT', `/api/step-results/${s.id}`, { status: 'Pass' });
  await admin.ok('PUT', `/api/step-results/${(await steps(ex[1]))[0].id}`, { status: 'Fail', actual: 'boom' });
  const states = (await admin.get(`/api/cycles/${cycle.id}`)).data.executions.map((e) => e.status);
  assert.deepEqual(states, ['Pass', 'Fail', 'Not Executed']);
  const failedOnly = (await admin.post(`/api/cycles/${cycle.id}/clone`, { name: 'Re-run', include: 'failed', build: '2' })).data;
  const c2 = (await admin.get(`/api/cycles/${failedOnly.id}`)).data;
  assert.equal(c2.executions.length, 1);
  assert.equal(c2.build, '2');
  assert.equal(c2.environment, 'Stage');
  assert.ok((await steps(c2.executions[0])).every((s) => s.status === 'Not Executed' && s.actual === ''));
  assert.equal((await admin.post(`/api/cycles/${cycle.id}/clone`, { include: 'unpassed' })).data.added, 2);
  assert.equal((await admin.post(`/api/cycles/${cycle.id}/clone`, { include: 'all' })).data.added, 3);
  assert.equal((await admin.post(`/api/cycles/${cycle.id}/clone`, { include: 'x' })).status, 400);
  const run = (await admin.post('/api/cases/1/run')).data;
  const adhoc = (await admin.get(`/api/executions/${run.executionId}`)).data;
  assert.equal(adhoc.adhoc, 1);
  assert.equal(adhoc.prev, null);
  assert.equal((await admin.post(`/api/cycles/${adhoc.cycle_id}/clone`)).status, 400, 'standalone runs cannot be cloned');
  assert.equal((await admin.post(`/api/cycles/${adhoc.cycle_id}/cases`, { caseIds: [2] })).status, 400);
});

test('deleting a case keeps its history and lets a clone carry the old snapshot', async () => {
  const c = (await admin.post('/api/projects/1/cases', { title: 'Doomed', steps: [{ action: 'x', expected: 'y' }] })).data;
  const cycle = (await admin.post('/api/projects/1/cycles', { name: 'Doom', caseIds: [c.id] })).data;
  const ex = (await admin.get(`/api/cycles/${cycle.id}`)).data.executions[0];
  await admin.ok('PUT', `/api/step-results/${(await admin.get(`/api/executions/${ex.id}`)).data.steps[0].id}`, { status: 'Fail' });
  await admin.ok('DELETE', `/api/cases/${c.id}`);
  assert.equal((await admin.get(`/api/cycles/${cycle.id}`)).data.executions[0].case_id, null);
  const clone = (await admin.post(`/api/cycles/${cycle.id}/clone`, { include: 'failed' })).data;
  const e2 = (await admin.get(`/api/cycles/${clone.id}`)).data.executions[0];
  assert.equal(e2.case_id, null);
  assert.equal((await admin.get(`/api/executions/${e2.id}`)).data.steps.length, 1);
});
