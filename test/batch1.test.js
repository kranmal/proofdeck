'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');
const { parseGherkin, gherkinSteps } = require('../lib/gherkin');

let ctx, a, tess, vic, rae;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  rae = await addUser(ctx.server, a, 'rae', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
});
after(() => ctx.server.stop());

const field = (body) => a.post('/api/projects/1/fields', body);
const caseWith = async (body = {}) => (await a.post('/api/projects/1/cases', { title: 'C', steps: [{ action: 'x', expected: 'y' }], ...body })).data;
const getCase = async (id, c = a) => (await c.get(`/api/cases/${id}`)).data;

// ---------------- custom fields ----------------
test('custom fields: definitions are admin-only and validated; keys come from the label', async () => {
  assert.equal((await tess.client.post('/api/projects/1/fields', { entity: 'case', label: 'Component', type: 'text' })).status, 403);
  assert.equal((await field({ entity: 'nope', label: 'X', type: 'text' })).status, 400);
  assert.equal((await field({ entity: 'case', label: 'X', type: 'colour' })).status, 400);
  assert.equal((await field({ entity: 'case', label: '', type: 'text' })).status, 400);
  assert.equal((await field({ entity: 'case', label: 'Pick', type: 'select' })).status, 400, 'a choice field needs options');
  assert.equal((await field({ entity: 'case', label: '!!!', type: 'text' })).status, 400);
  const comp = (await field({ entity: 'case', label: 'Component', type: 'select', options: ['Web', 'API', 'Mobile', 'Web'] })).data;
  assert.equal(comp.key, 'component');
  assert.equal((await field({ entity: 'case', label: 'component', type: 'text' })).status, 409, 'unique per entity');
  assert.equal((await field({ entity: 'bug', label: 'Component', type: 'text' })).status, 200, 'but the same name can exist on another entity');
  await field({ entity: 'case', label: 'Risk score', type: 'number' });
  await field({ entity: 'case', label: 'Automated', type: 'checkbox' });
  await field({ entity: 'case', label: 'Review by', type: 'date' });
  await field({ entity: 'case', label: 'Owner team', type: 'text', required: true });
  const list = (await tess.client.get('/api/projects/1/fields?entity=case')).data;
  assert.deepEqual(list.map((f) => f.key), ['component', 'risk_score', 'automated', 'review_by', 'owner_team']);
  assert.deepEqual(list[0].options, ['Web', 'API', 'Mobile'], 'duplicate options are dropped');
  assert.equal(list.find((f) => f.key === 'owner_team').required, true);
});

test('custom field values: typed, validated, required only when values are sent, cleared by empty', async () => {
  const c = await caseWith({ fields: { component: 'API', risk_score: '7.5', automated: true, review_by: '2027-01-31', owner_team: 'Payments', unknown: 'ignored' } });
  assert.deepEqual((await getCase(c.id)).fields, { component: 'API', risk_score: '7.5', automated: '1', review_by: '2027-01-31', owner_team: 'Payments' });
  const bad = (f) => a.put(`/api/cases/${c.id}`, { fields: f });
  assert.equal((await bad({ component: 'Desktop' })).status, 400, 'not one of the options');
  assert.equal((await bad({ risk_score: 'high' })).status, 400);
  assert.equal((await bad({ review_by: '31/01/2027' })).status, 400);
  assert.equal((await bad({ review_by: '2027-13-45' })).status, 400);
  assert.equal((await bad({ owner_team: '  ' })).status, 400, 'required');
  assert.match((await bad({ owner_team: '' })).data.error, /“Owner team” is required/);
  await a.ok('PUT', `/api/cases/${c.id}`, { fields: { risk_score: '' } });
  assert.equal((await getCase(c.id)).fields.risk_score, undefined, 'empty clears');
  await a.ok('PUT', `/api/cases/${c.id}`, { title: 'No fields sent' });
  assert.equal((await getCase(c.id)).fields.component, 'API', 'a save that does not mention fields leaves them');
  assert.equal((await a.post('/api/projects/1/cases', { title: 'Missing required', fields: { component: 'Web' } })).status, 400, 'required is enforced when fields are sent');
  assert.equal((await a.post('/api/projects/1/cases', { title: 'Plain create' })).status, 200, 'automated paths that send no fields are never blocked');
  assert.equal((await a.put(`/api/cases/${c.id}`, { fields: 'nope' })).status, 400);
  const copy = (await a.post(`/api/cases/${c.id}/clone`)).data;
  assert.equal((await getCase(copy.id)).fields.component, 'API', 'clone copies values');
});

test('custom fields on bugs and cycles; archive hides, delete removes values; viewers read only', async () => {
  const tier = (await field({ entity: 'bug', label: 'Customer impact', type: 'select', options: ['None', 'Some', 'Many'] })).data;
  const bug = (await a.post('/api/projects/1/bugs', { title: 'B', fields: { customer_impact: 'Many', component: 'Checkout' } })).data;
  assert.deepEqual((await a.get(`/api/bugs/${bug.id}`)).data.fields, { customer_impact: 'Many', component: 'Checkout' });
  await tess.client.ok('PUT', `/api/bugs/${bug.id}`, { fields: { customer_impact: 'Some' } });
  assert.equal((await a.get(`/api/bugs/${bug.id}`)).data.fields.customer_impact, 'Some');
  const bc = (await field({ entity: 'cycle', label: 'Sprint', type: 'text' })).data;
  const cyc = (await a.post('/api/projects/1/cycles', { name: 'CF', caseIds: [1], fields: { sprint: '42' } })).data;
  assert.equal((await a.get(`/api/cycles/${cyc.id}`)).data.fields.sprint, '42');
  await a.ok('PUT', `/api/cycles/${cyc.id}`, { fields: { sprint: '43' } });
  assert.equal((await a.get(`/api/cycles/${cyc.id}`)).data.fields.sprint, '43');
  assert.equal((await vic.client.put(`/api/bugs/${bug.id}`, { fields: { customer_impact: 'None' } })).status, 403);

  await a.ok('PUT', `/api/fields/${tier.id}`, { archived: true });
  assert.equal((await a.get(`/api/bugs/${bug.id}`)).data.fields.customer_impact, undefined, 'archived fields are hidden');
  assert.ok(!(await tess.client.get('/api/projects/1/fields?entity=bug')).data.some((f) => f.key === 'customer_impact'));
  assert.ok((await a.get('/api/projects/1/fields?entity=bug&all=1')).data.some((f) => f.key === 'customer_impact' && f.archived), 'admins can still see them');
  await a.ok('PUT', `/api/fields/${tier.id}`, { archived: false, label: 'Customer impact (renamed)' });
  assert.equal((await a.get(`/api/bugs/${bug.id}`)).data.fields.customer_impact, 'Some', 'values survive archiving');
  await a.ok('DELETE', `/api/fields/${tier.id}`);
  assert.equal((await a.get(`/api/bugs/${bug.id}`)).data.fields.customer_impact, undefined);
  await a.ok('DELETE', `/api/bugs/${bug.id}`);
  assert.ok(bc.id);
});

// ---------------- review / approval ----------------
test('review: request, approve, request changes, withdraw, with the right people notified', async () => {
  const c = await caseWith({ title: 'Needs review' });
  const review = (u, body) => u.post(`/api/cases/${c.id}/review`, body);
  assert.equal((await review(tess.client, { action: 'approve' })).status, 400, 'not in review yet');
  assert.equal((await review(tess.client, { action: 'request', reviewer_id: tess.id })).status, 400, 'not yourself');
  assert.equal((await review(tess.client, { action: 'request', reviewer_id: vic.id })).status, 400, 'a viewer cannot approve');
  assert.equal((await review(tess.client, { action: 'request' })).status, 400);
  assert.equal((await review(vic.client, { action: 'request', reviewer_id: rae.id })).status, 403, 'viewers cannot ask either');
  const r = await review(tess.client, { action: 'request', reviewer_id: rae.id, note: 'Please check the data' });
  assert.equal(r.data.status, 'In Review');
  const got = await getCase(c.id);
  assert.deepEqual([got.status, got.reviewer_name, got.review_note], ['In Review', 'RAE', 'Please check the data']);
  const note = (await rae.client.get('/api/notifications')).data.items[0];
  assert.match(note.title, /TESS asked you to review .*: Needs review/);
  assert.equal(note.link, `#/cases/${c.id}`);
  assert.equal((await review(tess.client, { action: 'request', reviewer_id: rae.id })).status, 400, 'already in review');
  assert.equal((await review(tess.client, { action: 'approve' })).status, 403, 'only the reviewer decides');
  assert.equal((await review(rae.client, { action: 'reject' })).status, 400, 'say what to change');
  assert.equal((await review(rae.client, { action: 'reject', note: 'Step 2 is unclear' })).data.status, 'Draft');
  assert.match((await tess.client.get('/api/notifications')).data.items[0].title, /RAE asked for changes to .*: Needs review/);
  assert.equal((await getCase(c.id)).review_note, 'Step 2 is unclear');
  await review(tess.client, { action: 'request', reviewer_id: rae.id });
  assert.equal((await review(rae.client, { action: 'approve', note: 'Looks good' })).data.status, 'Approved');
  const done = await getCase(c.id);
  assert.deepEqual([done.status, done.approved_by_name, done.review_note], ['Approved', 'RAE', 'Looks good']);
  assert.ok(done.approved_at);
  assert.match((await tess.client.get('/api/notifications')).data.items[0].title, /RAE approved/);
  assert.deepEqual((await a.get(`/api/cases/${c.id}/versions`)).data.slice(0, 2).map((v) => v.note), ['Approved', 'Sent for review']);
  const c2 = await caseWith({ title: 'Withdraw me' });
  await tess.client.post(`/api/cases/${c2.id}/review`, { action: 'request', reviewer_id: rae.id });
  assert.equal((await rae.client.post(`/api/cases/${c2.id}/review`, { action: 'withdraw' })).status, 403);
  assert.equal((await tess.client.post(`/api/cases/${c2.id}/review`, { action: 'withdraw' })).data.status, 'Draft');
  assert.equal((await a.post(`/api/cases/${c2.id}/review`, { action: 'nope' })).status, 400);
});

test('review lists, and strict approval makes review the only way to approve (admins excepted)', async () => {
  const mine = await caseWith({ title: 'For rae' });
  await tess.client.post(`/api/cases/${mine.id}/review`, { action: 'request', reviewer_id: rae.id });
  assert.ok((await rae.client.get('/api/projects/1/reviews?mine=1')).data.some((x) => x.id === mine.id));
  assert.ok(!(await tess.client.get('/api/projects/1/reviews?mine=1')).data.some((x) => x.id === mine.id));
  assert.ok((await tess.client.get('/api/projects/1/reviews')).data.some((x) => x.id === mine.id && x.reviewer_name === 'RAE' && x.requested_by_name === 'TESS'));
  const sum = (await rae.client.get('/api/projects/1/summary')).data;
  assert.ok(sum.mine.reviews >= 1, 'the overview counts reviews waiting for you');

  assert.equal((await tess.client.put('/api/projects/1/workflow', { strictApproval: true })).status, 403);
  await a.ok('PUT', '/api/projects/1/workflow', { strictApproval: true });
  assert.equal((await tess.client.get('/api/projects/1/workflow')).data.strictApproval, true);
  const d = await caseWith({ title: 'Strict' });
  assert.equal((await tess.client.put(`/api/cases/${d.id}`, { status: 'Approved' })).status, 403);
  assert.equal((await tess.client.post('/api/projects/1/cases', { title: 'Born approved', status: 'Approved' })).status, 403);
  assert.equal((await tess.client.put(`/api/cases/${d.id}`, { status: 'Deprecated' })).status, 200, 'other statuses are unaffected');
  assert.equal((await a.put(`/api/cases/${d.id}`, { status: 'Approved' })).status, 200, 'admins may approve directly');
  assert.equal((await tess.client.put(`/api/cases/${d.id}`, { status: 'Approved', title: 'Still approved' })).status, 200, 'already approved: no change in approval state');
  await a.ok('PUT', '/api/projects/1/workflow', { strictApproval: false });
  assert.equal((await tess.client.put(`/api/cases/${mine.id}`, { status: 'Approved' })).status, 200, 'and with strict off anyone can');
});

// ---------------- Gherkin ----------------
test('the Gherkin reader: steps, background, outlines, tables, and helpful errors', () => {
  const ok = parseGherkin(`# a comment
Feature: Checkout
  Background:
    Given a signed-in customer
  @smoke
  Scenario Outline: Pay with <method>
    Given the cart has <qty> items
    When they pay with <method>
    And they confirm
    Then an order is created
      | field | value |
      | total | 10 |
    Examples:
      | qty | method |
      | 1   | card   |
      | 2   | paypal |`);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.outline, true);
  assert.deepEqual(ok.examples, { columns: ['qty', 'method'], rows: [['1', 'card'], ['2', 'paypal']] });
  assert.deepEqual(gherkinSteps(ok).map((s) => s.action), ['Given a signed-in customer', 'Given the cart has {{qty}} items', 'When they pay with {{method}}', 'And they confirm', 'Then an order is created\n| field | value |\n| total | 10 |']);
  const errs = (t) => parseGherkin(t).errors[0];
  assert.match(errs(''), /Write a Scenario/);
  assert.match(errs('Scenario: x'), /no steps/);
  assert.match(errs('Scenario: a\n Given x\nScenario: b\n Given y'), /one scenario/);
  assert.match(errs('Given orphan'), /inside a Scenario/);
  assert.match(errs('Scenario: a\n Given x\n nonsense words'), /could not read “nonsense words”/);
  assert.match(errs('Scenario Outline: a\n Given <x>'), /needs an Examples table/);
  assert.match(errs('Scenario Outline: a\n Given <x>\n Examples:\n | y |\n | 1 |'), /<x> but the Examples table has no such column/);
  assert.match(errs('Scenario Outline: a\n Given <x>\n Examples:\n | x |\n | 1 | 2 |'), /different number of cells/);
  assert.match(errs('Scenario: a\n Given x\n Examples:\n | x |\n | 1 |'), /only belong under a Scenario Outline/);
  assert.match(errs('Scenario: a\n Given x\n """\n open'), /never closed/);
  assert.equal(parseGherkin('Scenario: a\n * a star step').scenario.steps[0].keyword, 'Step');
});

test('a Gherkin test case: validated on save, run as steps, an outline brings its own data sets, versioned', async () => {
  const script = `Feature: Login
  Scenario Outline: Sign in as <role>
    Given the user "<user>" exists
    When they sign in
    Then they see the <role> dashboard
    Examples:
      | user | role |
      | ann  | admin |
      | bob  | viewer |`;
  assert.equal((await a.post('/api/projects/1/cases', { title: 'Bad', script_type: 'bdd', bdd_script: 'Scenario: x' })).status, 400);
  const bad = await a.post('/api/projects/1/cases', { title: 'Bad', script_type: 'bdd', bdd_script: 'Scenario: x\n  Given y\n  oops' });
  assert.match(bad.data.error, /The Gherkin script has a problem: line 3/);
  assert.ok(bad.data.errors.length);
  assert.equal((await a.post('/api/projects/1/cases', { title: 'Bad type', script_type: 'cucumber' })).status, 400);
  const made = (await a.post('/api/projects/1/cases', { title: 'BDD login', script_type: 'bdd', bdd_script: script })).data;
  const c = await getCase(made.id);
  assert.deepEqual([c.script_type, c.bdd_steps.length, c.bdd_examples.rows.length, c.bdd_errors], ['bdd', 3, 2, []]);
  assert.equal((await a.put(`/api/cases/${made.id}`, { bdd_script: 'garbage' })).status, 400);
  assert.equal((await getCase(made.id)).bdd_script, script, 'a refused save changes nothing');

  const cyc = (await a.post('/api/projects/1/cycles', { name: 'BDD run', caseIds: [made.id] })).data;
  const execs = (await a.get(`/api/cycles/${cyc.id}`)).data.executions;
  assert.deepEqual(execs.map((e) => [e.iteration, e.iteration_label]), [[1, 'user=ann; role=admin'], [2, 'user=bob; role=viewer']]);
  const steps = (await a.get(`/api/executions/${execs[1].id}`)).data.steps;
  assert.deepEqual(steps.map((s) => s.action), ['Given the user "bob" exists', 'When they sign in', 'Then they see the viewer dashboard']);
  assert.equal((await a.get('/api/projects/1/cases')).data.find((x) => x.id === made.id).script_type, 'bdd');

  await a.ok('PUT', `/api/cases/${made.id}`, { bdd_script: script.replace('When they sign in', 'When they log in') });
  const v2 = (await a.get(`/api/cases/${made.id}/versions/2`)).data.snapshot;
  assert.equal(v2.script_type, 'bdd');
  assert.equal((await a.post(`/api/cases/${made.id}/versions/1/restore`)).status, 200);
  assert.match((await getCase(made.id)).bdd_script, /When they sign in/);
  await a.ok('PUT', `/api/cases/${made.id}`, { script_type: 'steps', steps: [{ action: 'plain', expected: 'ok' }] });
  const plain = (await a.post('/api/projects/1/cycles', { name: 'plain', caseIds: [made.id] })).data;
  assert.equal((await a.get(`/api/cycles/${plain.id}`)).data.executions.length, 1, 'back to step-by-step: the outline data no longer applies');
});
