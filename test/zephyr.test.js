'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startAdmin, addUser } = require('./helpers');

// Fake Zephyr Scale Cloud (v2) and Server/DC (rest/atm/1.0), with paging.
const TOKEN = 'zephyr_secret_token';
const send = (res, s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const serve = (h) => new Promise((resolve) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() })); });

const cloudCases = Array.from({ length: 230 }, (_, i) => ({
  key: `PROJ-T${i + 1}`, name: `Cloud case ${i + 1}`, objective: i === 0 ? '<p>The <b>objective</b></p>' : '', precondition: i === 0 ? 'Logged in' : '',
  priority: { id: i % 2 ? 2 : 1 }, status: { id: i % 3 ? 11 : 12 }, folder: i < 2 ? { id: 21 } : null, labels: i === 0 ? ['smoke', 'web'] : [], testScript: { self: 'x' },
}));
const steps = {
  'PROJ-T1': [{ inline: { description: 'Open the <b>page</b>', testData: 'http://x', expectedResult: 'It loads' } }, { inline: { description: 'Click login', testData: '', expectedResult: 'Form' } }, { testCase: { testCaseKey: 'PROJ-T2' } }],
  'PROJ-T2': [{ inline: { description: 'Only step', testData: '', expectedResult: 'Done' } }],
};
const calls = { cloud: [] };
const cloud = () => serve((req, res) => {
  calls.cloud.push(req.url);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { message: 'Unauthorized' });
  const u = new URL(req.url, 'http://x'); const start = Number(u.searchParams.get('startAt') || 0), max = Number(u.searchParams.get('maxResults') || 50); let m;
  const page = (list) => send(res, 200, { startAt: start, maxResults: max, total: list.length, isLast: start + max >= list.length, values: list.slice(start, start + max) });
  if (u.pathname === '/v2/priorities') return page([{ id: 1, name: 'High' }, { id: 2, name: 'Low' }]);
  if (u.pathname === '/v2/statuses') return page([{ id: 11, name: 'Approved' }, { id: 12, name: 'Draft' }]);
  if (u.pathname === '/v2/folders') return page([{ id: 20, parentId: null, name: 'Auth' }, { id: 21, parentId: 20, name: 'Login' }]);
  if (u.pathname === '/v2/testcases') return page(cloudCases);
  if ((m = /^\/v2\/testcases\/([\w-]+)\/teststeps$/.exec(u.pathname))) return page(steps[m[1]] || []);
  if ((m = /^\/v2\/testcases\/([\w-]+)\/testscript$/.exec(u.pathname))) return send(res, 200, m[1] === 'PROJ-T3' ? { type: 'bdd', text: 'Feature: x\n  Scenario: y\n    Given z' } : { type: 'plain', text: 'n/a' });
  send(res, 404, { message: 'not found' });
});

const serverCases = [
  { key: 'PROJ-T1', name: 'Server case', objective: 'Obj', precondition: 'Pre', priority: 'High', status: 'Approved', folder: '/Auth/Login', labels: ['a'], testScript: { type: 'STEP_BY_STEP', steps: [{ description: 'Do it', testData: 'd', expectedResult: 'ok' }, { testCaseKey: 'PROJ-T2' }] } },
  { key: 'PROJ-T2', name: 'Gherkin one', priority: 'Normal', status: 'Draft', folder: '/', labels: [], testScript: { type: 'BDD', text: 'Feature: F\n  Scenario: S\n    Given a' } },
];
const seen = { server: [] };
const server = () => serve((req, res) => {
  seen.server.push(req.url);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { errorMessages: ['not authenticated'] });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/rest/atm/1.0/testcase/search') { assert.equal(u.searchParams.get('query'), 'projectKey = "PROJ"'); return send(res, 200, serverCases); }
  send(res, 404, { message: 'nope' });
});

let ctx, a, tess, vic, F = {};
before(async () => {
  F = { cloud: await cloud(), server: await server() };
  ctx = await startAdmin();
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
});
after(() => { Object.values(F).forEach((s) => s.close()); ctx.server.stop(); });

const pull = (c, body) => c.post('/api/import/zephyr', body);

test('Cloud: cases, steps, folders, priorities and statuses come back as an import-ready table, across several pages', async () => {
  const r = await pull(a, { variant: 'cloud', base: `${F.cloud.url}/v2`, projectKey: 'proj', token: TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.format, 'zephyr');
  assert.equal(r.data.count, 230, 'three pages of cases');
  assert.deepEqual(r.data.headers.slice(0, 8), ['Key', 'Name', 'Objective', 'Precondition', 'Priority', 'Status', 'Folder', 'Labels']);
  assert.ok(r.data.headers.includes('Gherkin script'), 'one case has a BDD script');
  const h = r.data.headers, col = (row, name) => row[h.indexOf(name)];
  const first = r.data.rows[0];
  assert.deepEqual([col(first, 'Key'), col(first, 'Priority'), col(first, 'Status'), col(first, 'Folder'), col(first, 'Labels')], ['PROJ-T1', 'High', 'Draft', '/Auth/Login', 'smoke, web']);
  assert.equal(col(first, 'Test Script - Step'), 'Open the <b>page</b>');
  assert.equal(col(r.data.rows[1], 'Key'), '', 'steps continue on rows with no case fields');
  assert.equal(col(r.data.rows[2], 'Test Script - Step'), 'Call test case PROJ-T2', 'a call-to-test step');
  assert.equal(r.data.hasHtml, true);
  assert.equal(r.data.mapping.title, 1);
  const t3 = r.data.rows.find((row) => col(row, 'Key') === 'PROJ-T3');
  assert.match(col(t3, 'Gherkin script'), /^Feature: x/);
  assert.ok(calls.cloud.every((u) => !u.includes(TOKEN)), 'the token travels in a header only');
});

test('the table feeds the normal import: preview, create, then update by key', async () => {
  const r = (await pull(a, { variant: 'cloud', base: `${F.cloud.url}/v2`, projectKey: 'PROJ', token: TOKEN })).data;
  const dry = await a.ok('POST', '/api/projects/1/import', { rows: r.rows, mapping: r.mapping, mode: 'create', stripHtml: true, dryRun: true });
  assert.equal(dry.cases, 230);
  assert.ok(dry.steps >= 4);
  const done = await a.ok('POST', '/api/projects/1/import', { rows: r.rows, mapping: r.mapping, mode: 'create', stripHtml: true });
  assert.equal(done.created, 230);
  const list = (await a.get('/api/projects/1/cases')).data;
  const c = list.find((x) => x.title === 'Cloud case 1');
  const full = (await a.get(`/api/cases/${c.id}`)).data;
  assert.deepEqual([full.objective, full.priority, full.status, full.folder, full.labels], ['The objective', 'High', 'Draft', 'Auth/Login', 'smoke, web']);
  assert.equal(full.steps.length, 3);
  assert.equal(full.steps[0].action, 'Open the page', 'HTML removed when asked');
  assert.equal(full.steps[2].call_key !== null, true, 'the call step was linked to the imported case');
});

test('Server / Data Center: steps inline, BDD scripts, folder paths', async () => {
  const r = await pull(a, { variant: 'server', base: F.server.url, projectKey: 'PROJ', token: TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const h = r.data.headers, col = (row, name) => row[h.indexOf(name)];
  assert.deepEqual([r.data.count, r.data.rows.length], [2, 3]);
  assert.deepEqual([col(r.data.rows[0], 'Folder'), col(r.data.rows[0], 'Priority'), col(r.data.rows[1], 'Test Script - Step')], ['/Auth/Login', 'High', 'Call test case PROJ-T2']);
  const bdd = r.data.rows.find((row) => col(row, 'Key') === 'PROJ-T2');
  assert.match(col(bdd, 'Gherkin script'), /Scenario: S/);
  assert.ok(seen.server.every((u) => !u.includes(TOKEN)));
});

test('errors are explained, tokens never echoed, and only people who can create cases may use it', async () => {
  const bad = await pull(a, { variant: 'cloud', base: `${F.cloud.url}/v2`, projectKey: 'PROJ', token: 'wrong-token-value' });
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /Zephyr Scale said: Unauthorized.*Check the token/);
  assert.ok(!bad.data.error.includes('wrong-token-value'));
  assert.equal((await pull(a, { variant: 'cloud', projectKey: 'x', token: TOKEN })).status, 400, 'project key checked');
  assert.equal((await pull(a, { variant: 'cloud', base: 'http://example.com/v2', projectKey: 'PROJ', token: TOKEN })).status, 400, 'https only');
  assert.equal((await pull(a, { variant: 'cloud', base: `${F.cloud.url}/v2`, projectKey: 'PROJ', token: '' })).status, 400);
  assert.equal((await pull(a, { variant: 'server', projectKey: 'PROJ', token: TOKEN })).status, 400, 'a server needs its address');
  assert.equal((await pull(vic.client, { variant: 'cloud', base: `${F.cloud.url}/v2`, projectKey: 'PROJ', token: TOKEN })).status, 403);
  assert.equal((await pull(tess.client, { variant: 'cloud', base: `${F.cloud.url}/v2`, projectKey: 'PROJ', token: TOKEN })).status, 200);
  const empty = await pull(a, { variant: 'server', base: F.server.url + '/nope', projectKey: 'PROJ', token: TOKEN });
  assert.ok([400, 502].includes(empty.status));
});
