'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startAdmin, addUser, Client, rawRequest } = require('./helpers');

let ctx, a, token, tokenId, ci;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  const t = (await a.post('/api/projects/1/api-tokens', { name: 'GitHub Actions' })).data;
  token = t.token; tokenId = t.id;
  ci = new Client(ctx.server.base);
});
after(() => ctx.server.stop());

const call = (method, url, body, opts = {}) => fetch(ctx.server.base + url, {
  method,
  headers: { Authorization: `Bearer ${opts.token ?? token}`, ...(body !== undefined ? { 'Content-Type': opts.type || 'application/json' } : {}) },
  body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
const post = (body, opts) => call('POST', '/api/ci/results', body, opts);
const junit = (xml, qs = '') => call('POST', `/api/ci/junit?${qs}`, xml, { raw: true, type: 'application/xml' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');

test('tokens: admin-only, shown once, stored hashed, usable only on /api/ci', async () => {
  assert.match(token, /^pd_[A-Za-z0-9_-]{40}$/);
  const tess = await addUser(ctx.server, a, 'tess', 'tester');
  for (const [m, u] of [['get', '/api/projects/1/api-tokens'], ['post', '/api/projects/1/api-tokens'], ['del', `/api/api-tokens/${tokenId}`]]) {
    assert.equal((await tess.client[m](u, m === 'post' ? { name: 'x' } : undefined)).status, 403, `${m} ${u}`);
  }
  assert.equal((await a.post('/api/projects/1/api-tokens', { name: '  ' })).status, 400);
  const list = (await a.get('/api/projects/1/api-tokens')).data;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].name, list[0].prefix, list[0].revoked_at, list[0].created_by_name], ['GitHub Actions', token.slice(0, 8), null, 'Ada Admin']);
  assert.ok(!JSON.stringify(list).includes(token), 'the listing never contains the token');
  for (const f of fs.readdirSync(ctx.server.dir).filter((x) => x.startsWith('proofdeck.db'))) {
    assert.equal(fs.readFileSync(path.join(ctx.server.dir, f)).indexOf(token), -1, `${f} must not contain the token`);
  }
  // a token is not a login: the normal API refuses it
  for (const u of ['/api/projects', '/api/projects/1/cases', '/api/users', '/api/projects/1/api-tokens']) {
    assert.equal((await call('GET', u)).status, 401, u);
  }
  assert.equal((await call('POST', '/api/projects', { name: 'Evil', key: 'EVIL' })).status, 401);
  // and CI routes refuse a browser session
  assert.equal((await a.post('/api/ci/results', { cycle: { name: 'x' }, results: [] })).status, 401);
  assert.equal((await ci.get('/api/ci/cycle?id=1')).status, 401);
  for (const bad of ['Bearer nope', `Basic ${token}`]) {  // few attempts here: the limiter is tested at the end
    const r = await fetch(`${ctx.server.base}/api/ci/cycle?id=1`, { headers: bad ? { Authorization: bad } : {} });
    assert.equal(r.status, 401, bad);
  }
});

test('results by case key: cycle is created once and reused; execution carries the token label', async () => {
  const body = { cycle: { name: 'Nightly', build: '1.2.3', environment: 'CI' }, results: [
    { case: 'DEMO-T1', status: 'Pass', duration_ms: 1500 },
    { case: 'demo-t2', status: 'failed', message: 'Expected 1 but got 0\nstack…' },
    { case: 3, status: 'Blocked' },
  ] };
  const r = await post(body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.equal(r.data.cycle.created, true);
  assert.deepEqual(r.data.counts, { total: 3, pass: 1, fail: 1, blocked: 1, not_run: 0 });
  assert.deepEqual(r.data.results.map((x) => [x.case, x.status]), [['DEMO-T1', 'Pass'], ['DEMO-T2', 'Fail'], ['DEMO-T3', 'Blocked']]);
  const cyc = (await a.get(`/api/cycles/${r.data.cycle.id}`)).data;
  assert.deepEqual([cyc.name, cyc.build, cyc.environment], ['Nightly', '1.2.3', 'CI']);
  assert.match(cyc.description, /GitHub Actions/);
  const ex = Object.fromEntries(cyc.executions.map((e) => [e.case_key, e]));
  assert.equal(ex['DEMO-T1'].executed_by_name, 'API: GitHub Actions');
  const t1 = (await a.get(`/api/executions/${ex['DEMO-T1'].id}`)).data;
  assert.equal(t1.status, 'Pass');
  assert.ok(t1.steps.every((s) => s.status === 'Pass'), 'a passing result marks every step');
  assert.equal(t1.comment, '(1.5 s)');
  const t2 = (await a.get(`/api/executions/${ex['DEMO-T2'].id}`)).data;
  assert.equal(t2.status, 'Fail');
  assert.match(t2.comment, /^\[CI\] Expected 1 but got 0/);
  // same name + build again: same cycle, results updated, nothing duplicated
  const again = await post({ cycle: { name: 'nightly', build: '1.2.3' }, results: [{ case: 'DEMO-T2', status: 'Pass' }] });
  assert.equal(again.data.cycle.created, false);
  assert.equal(again.data.cycle.id, r.data.cycle.id);
  assert.equal(again.data.counts.total, 3);
  assert.equal(again.data.counts.fail, 0);
  assert.equal((await a.get(`/api/cycles/${r.data.cycle.id}`)).data.executions.length, 3);
  // another build is another cycle; a cycle can also be addressed by id
  const other = await post({ cycle: { name: 'Nightly', build: '1.2.4' }, results: [{ case: 'DEMO-T1', status: 'Pass' }] });
  assert.notEqual(other.data.cycle.id, r.data.cycle.id);
  const byId = await post({ cycle: { id: r.data.cycle.id }, results: [{ case: 'DEMO-T3', status: 'Pass' }] });
  assert.equal(byId.data.counts.pass, 3);
});

test('per-step results roll up; explicit status wins; data-set iterations can be targeted', async () => {
  const r = await post({ cycle: { name: 'Steps' }, results: [
    { case: 'DEMO-T1', steps: [{ position: 1, status: 'Pass' }, { position: 2, status: 'Fail', actual: 'Button missing' }] },
    { case: 'DEMO-T2', status: 'Pass', steps: [{ position: 1, status: 'Fail' }] },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cyc = (await a.get(`/api/cycles/${r.data.cycle.id}`)).data;
  const t1 = (await a.get(`/api/executions/${cyc.executions.find((e) => e.case_key === 'DEMO-T1').id}`)).data;
  assert.equal(t1.status, 'Fail');
  assert.deepEqual(t1.steps.map((s) => s.status), ['Pass', 'Fail', 'Not Executed']);
  assert.equal(t1.steps[1].actual, 'Button missing');
  const t2 = (await a.get(`/api/executions/${cyc.executions.find((e) => e.case_key === 'DEMO-T2').id}`)).data;
  assert.equal(t2.status, 'Pass', 'an explicit overall status beats the roll-up');

  const ds = (await a.post('/api/projects/1/cases', { title: 'Data driven', steps: [{ action: 'Use {{v}}', expected: 'ok' }], params: { columns: ['v'], rows: [['a'], ['b'], ['c']] }, automation_key: 'dd::works' })).data;
  const one = await post({ cycle: { name: 'Datasets' }, results: [{ automation_key: 'dd::works', iteration: 2, status: 'Fail', message: 'row b broke' }] });
  const execs = (await a.get(`/api/cycles/${one.data.cycle.id}`)).data.executions;
  assert.deepEqual(execs.map((e) => [e.iteration, e.status]), [[1, 'Not Executed'], [2, 'Fail'], [3, 'Not Executed']]);
  assert.equal((await post({ cycle: { name: 'Datasets' }, results: [{ automation_key: 'dd::works', iteration: 9, status: 'Pass' }] })).data.results[0].error.includes('no data set 9'), true);
  const all = await post({ cycle: { name: 'Datasets all' }, results: [{ automation_key: 'dd::works', status: 'Pass' }] });
  assert.equal((await a.get(`/api/cycles/${all.data.cycle.id}`)).data.executions.filter((e) => e.status === 'Pass').length, 3, 'no iteration = every row');
  assert.ok(ds.id);
});

test('automation keys: match, bind on first sight, autoCreate, skip', async () => {
  const c = (await a.post('/api/projects/1/cases', { title: 'Keyed', steps: [{ action: 'x', expected: 'y' }], automation_key: 'suite::keyed' })).data;
  const bound = await post({ cycle: { name: 'Keys' }, results: [
    { automation_key: 'suite::keyed', status: 'Pass' },
    { case: 'DEMO-T1', automation_key: 'suite::bind-me', status: 'Pass' },
    { automation_key: 'suite::unknown', status: 'Pass' },
    { automation_key: 'suite::skipme', status: 'skipped' },
  ] });
  assert.equal(bound.status, 200);
  assert.equal(bound.data.ok, false);
  assert.deepEqual(bound.data.summary, { received: 4, recorded: 2, skipped: 1, errors: 1, created_cases: 0, bugs_created: 0, bugs_updated: 0 });
  assert.match(bound.data.results[2].error, /No test case has the automation key “suite::unknown”.*autoCreate/);
  assert.equal(bound.data.results[3].skipped, true);
  assert.equal((await a.get('/api/cases/1')).data.automation_key, 'suite::bind-me', 'sending case + key once binds it');
  const again = await post({ cycle: { name: 'Keys' }, results: [{ automation_key: 'suite::bind-me', status: 'Fail' }] });
  assert.equal(again.data.results[0].case, 'DEMO-T1');

  const made = await post({ cycle: { name: 'Keys' }, autoCreate: true, folder: 'CI/Auto', results: [
    { automation_key: 'suite::brand-new', title: 'A brand new test', status: 'Pass' }, { automation_key: 'suite::other-new', status: 'Fail', message: 'nope' }] });
  assert.equal(made.data.summary.created_cases, 2);
  const created = (await a.get('/api/projects/1/cases')).data.find((x) => x.automation_key === 'suite::brand-new');
  assert.deepEqual([created.title, created.folder, created.status, created.labels], ['A brand new test', 'CI/Auto', 'Draft', 'automated']);
  assert.ok((await a.get('/api/projects/1/cases')).data.some((x) => x.title === 'suite::other-new'), 'title falls back to the key');
  const cyc = (await a.get(`/api/cycles/${made.data.cycle.id}`)).data;
  assert.ok(cyc.executions.some((e) => e.case_title === 'A brand new test' && e.status === 'Pass'));
  assert.ok(c.id);
});

test('bad input is reported per result; strict mode saves nothing; malformed requests are 400', async () => {
  const mixed = await post({ cycle: { name: 'Mixed' }, results: [
    { case: 'DEMO-T1', status: 'Pass' }, { case: 'NOPE-T99', status: 'Pass' }, { case: 'DEMO-T2', status: 'maybe' }, { case: 'DEMO-T3' },
    { case: 'DEMO-T3', steps: [{ position: 99, status: 'Pass' }] }, 'junk', { status: 'Pass' },
  ] });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.data.summary.recorded, 1);
  assert.equal(mixed.data.summary.errors, 6);
  assert.match(mixed.data.results[1].error, /No test case “NOPE-T99”/);
  assert.match(mixed.data.results[2].error, /Unknown status “maybe”/);
  assert.match(mixed.data.results[3].error, /Give a "status"/);
  assert.match(mixed.data.results[4].error, /no step 99/);
  assert.match(mixed.data.results[5].error, /must be an object/);
  assert.match(mixed.data.results[6].error, /needs "case"/);
  const cyc = (await a.get(`/api/cycles/${mixed.data.cycle.id}`)).data;
  assert.equal(cyc.executions.length, 1, 'failed items left no half-created executions behind');

  const before = (await a.get('/api/projects/1/cycles')).data.length;
  const strict = await post({ cycle: { name: 'Strict' }, strict: true, results: [{ case: 'DEMO-T1', status: 'Pass' }, { case: 'NOPE-T1', status: 'Pass' }] });
  assert.equal(strict.status, 422);
  assert.match(strict.data.error, /Nothing was saved: 1 of 2/);
  assert.equal(strict.data.results[1].error.includes('NOPE-T1'), true);
  assert.equal((await a.get('/api/projects/1/cycles')).data.length, before, 'not even the cycle was created');

  for (const [body, re] of [[{ results: [{ case: 'DEMO-T1', status: 'Pass' }] }, /Say which cycle/], [{ cycle: { name: 'x' }, results: [] }, /non-empty list/], [{ cycle: { name: 'x' } }, /non-empty list/], [{ cycle: { id: 9999 }, results: [{ case: 'DEMO-T1', status: 'Pass' }] }, /does not exist/]]) {
    const r = await post(body);
    assert.ok(r.status === 400 || r.status === 404, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  }
  assert.equal((await post({ cycle: { name: 'x' }, results: Array(5001).fill({ case: 'DEMO-T1', status: 'Pass' }) })).status, 400, 'batch cap');
  assert.equal((await call('POST', '/api/ci/results', '{}', { raw: true, type: 'text/plain' })).status, 415);
  assert.equal((await fetch(`${ctx.server.base}/api/ci/results`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{nope' })).status, 400);
});

test('attachments go on the failing step; bugs are created once and later failures add a comment', async () => {
  const log = { filename: 'run.log', mime: 'text/plain', data: Buffer.from('boom happened\n').toString('base64') };
  const r = await post({ cycle: { name: 'Bugs', environment: 'CI', build: '7' }, createBugs: true, results: [
    { case: 'DEMO-T2', steps: [{ position: 1, status: 'Pass' }, { position: 2, status: 'Fail', actual: 'Cart badge is 0' }], message: 'Badge not updated\nmore detail', attachments: [log, { filename: 'shot.png', mime: 'image/png', data: PNG }, { filename: 'bad.exe', mime: 'application/x-msdownload', data: 'TVo=' }] },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const res = r.data.results[0];
  assert.equal(res.bug.existing, false);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /bad\.exe was not attached/);
  const exec = (await a.get(`/api/executions/${res.execution_ids[0]}`)).data;
  assert.deepEqual(exec.steps[1].attachments.map((x) => x.filename), ['run.log', 'shot.png'], 'attached to the failing step');
  const bug = (await a.get(`/api/projects/1/bugs`)).data.find((b) => b.key === res.bug.key);
  const full = (await a.get(`/api/bugs/${bug.id}`)).data;
  assert.equal(full.title, '[CI] DEMO-T2: Badge not updated');
  assert.equal(full.actual, 'Badge not updated\nmore detail');
  assert.equal(full.expected, 'Cart badge shows 1', 'expected comes from the failing step');
  assert.deepEqual([full.step_no, full.environment, full.reporter_name], [2, 'CI · Build 7', null]);
  assert.equal(full.attachments.length, 2, 'files are copied to the bug');
  assert.match(full.steps_to_reproduce, /API: GitHub Actions/);
  const second = await post({ cycle: { name: 'Bugs', build: '8' }, createBugs: true, results: [{ case: 'DEMO-T2', status: 'Fail', message: 'still broken' }] });
  assert.deepEqual([second.data.results[0].bug.existing, second.data.results[0].bug.key], [true, res.bug.key]);
  assert.equal(second.data.summary.bugs_updated, 1);
  const after2 = (await a.get(`/api/bugs/${bug.id}`)).data;
  assert.equal(after2.comments.length, 1);
  assert.match(after2.comments[0].body, /Failed again in .* \(API: GitHub Actions\): still broken/);
  const none = await post({ cycle: { name: 'Bugs', build: '9' }, results: [{ case: 'DEMO-T3', status: 'Fail' }] });
  assert.equal(none.data.results[0].bug, undefined, 'no bugs unless asked');
  const perResult = await post({ cycle: { name: 'Bugs', build: '9' }, results: [{ case: 'DEMO-T1', status: 'Fail', bug: true, message: 'one' }] });
  assert.ok(perResult.data.results[0].bug.key, 'a result can ask for a bug itself');
});

const JEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="4" failures="1"><testsuite name="login" tests="4">
 <testcase classname="login signs in" name="login signs in with valid credentials" time="0.512"/>
 <testcase classname="login rejects" name="login rejects a wrong password" time="1.2"><failure message="expect(received).toBe(expected)">Error: expect(received).toBe(expected) &amp; more
 at login.test.js:12</failure><system-out><![CDATA[console.log output <here>]]></system-out></testcase>
 <testcase classname="login" name="is skipped" time="0"><skipped/></testcase>
 <testcase classname="login" name="retried" time="0.1"><failure message="first try"/></testcase>
 <testcase classname="login" name="retried" time="0.1"/>
</testsuite></testsuites>`;

test('JUnit XML: keys, failures with output, skips, retries (last run wins), and the same options as JSON', async () => {
  const r = await junit(JEST, 'cycle=CI%20run&build=42&environment=GitHub&autoCreate=1&createBugs=1&folder=Jest');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.summary, { received: 4, recorded: 3, skipped: 1, errors: 0, created_cases: 3, bugs_created: 1, bugs_updated: 0 }, 'a skipped test creates no case');
  assert.deepEqual(r.data.counts, { total: 3, pass: 2, fail: 1, blocked: 0, not_run: 0 });
  const byKey = Object.fromEntries(r.data.results.map((x) => [x.automation_key, x]));
  assert.ok(byKey['login signs in::login signs in with valid credentials']);
  assert.equal(byKey['login::retried'].status, 'Pass', 'the retry that passed wins');
  assert.equal(byKey['login::is skipped'].skipped, true);
  const failed = byKey['login rejects::login rejects a wrong password'];
  assert.equal(failed.status, 'Fail');
  assert.ok(failed.bug.key);
  const ex = (await a.get(`/api/executions/${failed.execution_ids[0]}`)).data;
  assert.match(ex.comment, /^\[CI\] expect\(received\)\.toBe\(expected\)/);
  assert.match(ex.comment, /\(1\.2 s\)$/);
  const cases = (await a.get('/api/projects/1/cases')).data.filter((c) => c.folder === 'Jest');
  assert.equal(cases.length, 3, 'autoCreate put the new cases in the requested folder');
  // the failure text became a file; cases have no steps so it cannot attach, and says so
  assert.ok(failed.warnings.some((w) => /no steps/.test(w)));
  // key=name uses the bare test name; skipped=blocked maps skips; second upload reuses the cycle
  const again = await junit(JEST, 'cycle=CI%20run&build=42&autoCreate=1&key=name&skipped=blocked');
  assert.equal(again.data.cycle.created, false);
  assert.equal(again.data.summary.created_cases, 4, 'bare names are different keys');
  assert.equal(again.data.results.find((x) => x.automation_key === 'is skipped').status, 'Blocked');
  assert.equal((await junit('<html>not junit</html>', 'cycle=x')).status, 400);
  assert.equal((await junit('<testsuite></testsuite>', 'cycle=x')).status, 400);
  assert.equal((await call('POST', '/api/ci/junit?cycle=x', JEST, { raw: true, type: 'application/json' })).status, 415);
  assert.equal((await junit(JEST, '')).status, 400, 'a cycle is required');
  const hostile = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><testsuite><testcase name="t&xxe;"><failure message="&xxe; &#x41;"/></testcase></testsuite>';
  const h = await junit(hostile, 'cycle=Hostile&autoCreate=1');
  assert.equal(h.status, 200);
  assert.ok(!JSON.stringify(h.data).includes('root:'), 'external entities are never resolved');
});

test('JUnit from other runners: pytest, Maven and Playwright shapes', async () => {
  const pytest = '<testsuites><testsuite name="pytest" tests="2"><testcase classname="tests.test_login" name="test_ok" time="0.01"/><testcase classname="tests.test_login" name="test_bad" time="0.02"><failure message="assert 1 == 2">def test_bad():\n&gt;       assert 1 == 2\nE       assert 1 == 2</failure></testcase></testsuite></testsuites>';
  const r = await junit(pytest, 'cycle=Py&autoCreate=1');
  assert.deepEqual(r.data.results.map((x) => [x.automation_key, x.status]), [['tests.test_login::test_ok', 'Pass'], ['tests.test_login::test_bad', 'Fail']]);
  const maven = '<testsuite name="com.acme.LoginTest" tests="1"><testcase name="testLogin" classname="com.acme.LoginTest" time="0.5"><error message="NPE" type="java.lang.NullPointerException">java.lang.NullPointerException\n\tat com.acme.Login.run</error></testcase></testsuite>';
  const m = await junit(maven, 'cycle=Mvn&autoCreate=1');
  assert.equal(m.data.results[0].status, 'Fail');
  const mex = (await a.get(`/api/executions/${m.data.results[0].execution_ids[0]}`)).data;
  assert.match(mex.comment, /java\.lang\.NullPointerException: NPE/);
  const pw = '<testsuites><testsuite name="login.spec.ts"><testcase name="login › signs in" classname="login.spec.ts" time="2.5"/></testsuite></testsuites>';
  assert.equal((await junit(pw, 'cycle=PW&autoCreate=1')).data.results[0].automation_key, 'login.spec.ts::login › signs in');
});

test('gate endpoint reports counts and a verdict', async () => {
  const mk = async (name, results) => (await post({ cycle: { name }, results })).data.cycle.id;
  const green = await mk('Gate green', [{ case: 'DEMO-T1', status: 'Pass' }, { case: 'DEMO-T2', status: 'Pass' }, { case: 'DEMO-T3', status: 'Pass' }]);
  const red = await mk('Gate red', [{ case: 'DEMO-T1', status: 'Pass' }, { case: 'DEMO-T2', status: 'Fail' }]);
  const g = (await call('GET', `/api/ci/cycle?id=${green}`)).data;
  assert.deepEqual([g.status, g.ok, g.counts.pass], ['passing', true, 3]);
  assert.equal((await call('GET', `/api/ci/cycle?id=${red}`)).data.status, 'failing');
  const seed = (await call('GET', '/api/ci/cycle?id=1')).data;
  assert.deepEqual([seed.status, seed.ok, seed.counts.not_run], ['incomplete', false, 3], 'a cycle with tests still to run is not a pass');
  const byName = (await call('GET', '/api/ci/cycle?name=gate%20green&build=')).data;
  assert.deepEqual([byName.id, byName.status], [green, 'passing'], 'lookup by name and build, ignoring case');
  assert.equal((await call('GET', '/api/ci/cycle?id=99999')).status, 404);
  assert.equal((await call('GET', '/api/ci/cycle')).status, 404);
});

test('tokens are bound to their project; revoking kills them at once; bad tokens are rate limited', async () => {
  const other = (await a.post('/api/projects', { name: 'Other', key: 'OTH' })).data;
  const oc = (await a.post(`/api/projects/${other.id}/cases`, { title: 'Other case', steps: [{ action: 'x', expected: 'y' }], automation_key: 'other::case' })).data;
  const t2 = (await a.post(`/api/projects/${other.id}/api-tokens`, { name: 'Other CI' })).data.token;
  const cross = await post({ cycle: { name: 'X' }, results: [{ case: oc.key, status: 'Pass' }, { automation_key: 'other::case', status: 'Pass' }] });
  assert.match(cross.data.results[0].error, /No test case/, 'project 1 token cannot see project 2 cases');
  assert.match(cross.data.results[1].error, /No test case has the automation key/);
  const own = await post({ cycle: { name: 'Theirs' }, results: [{ case: oc.key, status: 'Pass' }] }, { token: t2 });
  assert.equal(own.data.summary.recorded, 1);
  const theirCycle = own.data.cycle.id;
  assert.equal((await post({ cycle: { id: theirCycle }, results: [{ case: 'DEMO-T1', status: 'Pass' }] })).status, 404, 'cannot write into another project’s cycle');
  assert.equal((await call('GET', `/api/ci/cycle?id=${theirCycle}`)).status, 404);

  const tmp = (await a.post('/api/projects/1/api-tokens', { name: 'Temp' })).data;
  assert.equal((await post({ cycle: { name: 'T' }, results: [{ case: 'DEMO-T1', status: 'Pass' }] }, { token: tmp.token })).status, 200);
  assert.equal((await a.del(`/api/api-tokens/${tmp.id}`)).status, 200);
  assert.equal((await post({ cycle: { name: 'T' }, results: [{ case: 'DEMO-T1', status: 'Pass' }] }, { token: tmp.token })).status, 401, 'revoked');
  const listed = (await a.get('/api/projects/1/api-tokens')).data.find((x) => x.id === tmp.id);
  assert.ok(listed.revoked_at && listed.last_used_at, 'revoked tokens stay listed with their last use');
  assert.equal((await a.del('/api/api-tokens/99999')).status, 404);

  // last_used_at is kept up to date
  assert.ok((await a.get('/api/projects/1/api-tokens')).data.find((x) => x.id === tokenId).last_used_at);
  // hammering with junk tokens gets the junk throttled
  let last;
  for (let i = 0; i < 6; i++) last = await call('GET', '/api/ci/cycle?id=1', undefined, { token: `pd_${'x'.repeat(40)}${i}` });
  assert.equal(last.status, 429, 'junk tokens are throttled');
  assert.equal((await call('GET', `/api/ci/cycle?id=${theirCycle}`, undefined, { token: t2 })).status, 200, 'but a valid token is never locked out');
  assert.equal((await call('GET', '/api/ci/cycle?id=1')).status, 200, 'including the first project’s token');
});
