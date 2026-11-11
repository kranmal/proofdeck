'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a, tess, vic;
before(async () => {
  ctx = await startAdmin({ NOTIFY_TICK_MS: '100', NOTIFY_DUE_MS: '0' });
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
  await a.ok('PUT', '/api/settings/notifications', { digestHour: 0 });
});
after(() => ctx.server.stop());

const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const cycle = async (name, extra = {}) => (await a.post('/api/projects/1/cycles', { name, caseIds: [1, 2, 3], ...extra })).data;
const cyc = async (id) => (await a.get(`/api/cycles/${id}`)).data;
async function passAll(id) {
  for (const e of (await cyc(id)).executions) for (const s of (await a.get(`/api/executions/${e.id}`)).data.steps) await a.ok('PUT', `/api/step-results/${s.id}`, { status: 'Pass' });
}

// ---------------- due dates ----------------
test('cycle dates are validated; overdue means past due with tests left; finished, future and standalone are never overdue', async () => {
  assert.equal((await a.post('/api/projects/1/cycles', { name: 'x', due_date: '31/12/2027' })).status, 400);
  assert.equal((await a.post('/api/projects/1/cycles', { name: 'x', due_date: '2027-02-30x' })).status, 400);
  assert.equal((await a.post('/api/projects/1/cycles', { name: 'x', start_date: '2027-05-02', due_date: '2027-05-01' })).status, 400);
  const late = await cycle('Late', { start_date: day(-10), due_date: day(-1) });
  const future = await cycle('Future', { due_date: day(3) });
  const done = await cycle('Done late', { due_date: day(-5) });
  await passAll(done.id);
  const none = await cycle('No date');
  const list = (await a.get('/api/projects/1/cycles')).data;
  const by = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.deepEqual([by.Late.overdue, by.Future.overdue, by['Done late'].overdue, by['No date'].overdue], [true, false, false, false]);
  assert.deepEqual([by.Late.start_date, by.Late.due_date], [day(-10), day(-1)]);
  assert.equal((await cyc(late.id)).overdue, true);
  assert.equal((await cyc(done.id)).overdue, false);
  const run = (await a.post('/api/cases/1/run')).data;
  const standalone = (await a.get('/api/projects/1/cycles')).data.find((c) => c.adhoc);
  assert.equal(standalone.overdue, false);
  assert.ok(run.executionId);
  assert.equal((await a.get('/api/projects/1/summary')).data.overdueCycles, 1, 'the overview counts overdue cycles');

  await a.ok('PUT', `/api/cycles/${late.id}`, { due_date: day(2) });
  assert.equal((await cyc(late.id)).overdue, false, 'extending the date clears it');
  assert.equal((await a.put(`/api/cycles/${late.id}`, { due_date: day(-30) })).status, 400, 'due before the start date');
  await a.ok('PUT', `/api/cycles/${late.id}`, { start_date: '', due_date: '' });
  assert.deepEqual([(await cyc(late.id)).start_date, (await cyc(late.id)).due_date], ['', ''], 'dates can be cleared');
  await a.ok('PUT', `/api/cycles/${late.id}`, { name: 'Late renamed' });
  assert.ok(none.id && future.id);
});

test('people with runs left in a cycle that is due or overdue get one reminder a day', async () => {
  const c = await cycle('Reminder cycle', { due_date: day(-2) });
  const execs = (await cyc(c.id)).executions;
  await a.ok('PUT', `/api/executions/${execs[0].id}`, { assignee_id: tess.id });
  await a.ok('PUT', `/api/executions/${execs[1].id}`, { assignee_id: tess.id });
  const find = async () => (await tess.client.get('/api/notifications')).data.items.filter((x) => x.kind === 'due' && x.link === `#/cycles/${c.id}`);
  const until = async (fn) => { const end = Date.now() + 5000; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 60)); } };
  const first = await until(async () => { const l = await find(); return l.length ? l : null; });
  assert.equal(first.length, 1);
  assert.match(first[0].title, /Reminder cycle is overdue \(was due /);
  assert.match(first[0].body, /\d+ of your test runs? (is|are) still to do/);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await find()).length, 1, 'not repeated the same day');
  const soon = await cycle('Due tomorrow', { due_date: day(1) });
  await a.ok('PUT', `/api/executions/${(await cyc(soon.id)).executions[0].id}`, { assignee_id: tess.id });
  await until(async () => (await tess.client.get('/api/notifications')).data.items.find((x) => x.link === `#/cycles/${soon.id}`));
  assert.match((await tess.client.get('/api/notifications')).data.items.find((x) => x.link === `#/cycles/${soon.id}`).title, /is due tomorrow/);
  assert.equal((await vic.client.get('/api/notifications')).data.items.filter((x) => x.kind === 'due').length, 0, 'people with nothing assigned hear nothing');
});

// ---------------- report filters ----------------
async function seedReports() {
  const web = (await a.post('/api/projects/1/cases', { title: 'Web case', folder: 'Web/Checkout', labels: 'smoke, ui', steps: [{ action: 'x', expected: 'y' }] })).data;
  const api = (await a.post('/api/projects/1/cases', { title: 'API case', folder: 'API', labels: 'regression', steps: [{ action: 'x', expected: 'y' }] })).data;
  const plan = (await a.post('/api/projects/1/plans', { name: 'Filter plan' })).data;
  const c1 = (await a.post('/api/projects/1/cycles', { name: 'R web', caseIds: [web.id], plan_id: plan.id })).data;
  const c2 = (await a.post('/api/projects/1/cycles', { name: 'R api', caseIds: [api.id] })).data;
  for (const [cid, st] of [[c1.id, 'Pass'], [c2.id, 'Fail']]) {
    const e = (await cyc(cid)).executions[0];
    for (const s of (await a.get(`/api/executions/${e.id}`)).data.steps) await a.ok('PUT', `/api/step-results/${s.id}`, { status: st, actual: 'x' });
  }
  const b = (await a.post('/api/projects/1/bugs', { title: 'API bug', severity: 'Major' })).data;
  return { web, api, plan, c1, c2, b };
}

test('report filters: dates, folder (with subfolders), label and plan narrow every section', async () => {
  const s = await seedReports();
  const get = async (qs) => (await a.get(`/api/projects/1/reports?${qs}`)).data;
  const all = await get('');
  assert.equal(all.filters.active, false);
  const names = (r) => r.trend.map((c) => c.name);
  assert.ok(names(all).includes('R web') && names(all).includes('R api'));

  const web = await get('folder=Web');
  assert.deepEqual(web.filters, { from: '', to: '', folder: 'Web', label: '', plan_id: null, active: true });
  assert.deepEqual(names(web).filter((n) => n.startsWith('R ')), ['R web', 'R api'], 'cycles stay listed but only count the matching cases');
  const wr = web.trend.find((c) => c.name === 'R web'), ar = web.trend.find((c) => c.name === 'R api');
  assert.deepEqual([wr.total, wr.pass], [1, 1]);
  assert.equal(ar.total, 0, 'a cycle with no matching cases counts nothing');
  assert.equal(web.coverage.Pass + web.coverage.Fail + web.coverage.Blocked + web.coverage['In Progress'] + web.coverage['Never run'], 1, 'coverage covers only the folder’s cases');
  assert.equal(web.failing.length, 0);
  assert.ok(all.failing.some((f) => f.key.endsWith('T5')) || all.failing.length >= 1);
  const apiOnly = await get('folder=API');
  assert.ok(apiOnly.failing.some((f) => f.title === 'API case'), 'failures of the matching case remain');
  assert.equal(apiOnly.bugs.total, 0, 'a folder filter also restricts bugs to those found by its cases');
  assert.equal((await get('label=SMOKE')).trend.find((c) => c.name === 'R web').total, 1, 'labels match ignoring case and spaces');
  assert.equal((await get('label=smo')).trend.find((c) => c.name === 'R web').total, 0, 'whole labels only');

  const plan = await get(`plan_id=${s.plan.id}`);
  assert.deepEqual(names(plan), ['R web']);
  assert.deepEqual(plan.failing, [], 'executions outside the plan are ignored');
  const future = await get(`from=${day(1)}`);
  assert.deepEqual(future.trend, []);
  assert.equal(future.bugs.total, 0);
  assert.equal(future.activity.length, 0);
  const todayOnly = await get(`from=${day()}&to=${day()}`);
  assert.ok(names(todayOnly).includes('R web'));
  assert.deepEqual((await get(`to=${day(-1)}`)).trend, [], 'nothing was created before today');
  assert.equal((await get(`from=${day()}`)).activity.find((x) => x.name === 'Ada Admin').executed >= 2, true);
  assert.ok(s.b.id);
});

test('report filters: bad input is refused and exports follow the filters', async () => {
  assert.equal((await a.get('/api/projects/1/reports?from=yesterday')).status, 400);
  assert.equal((await a.get('/api/projects/1/reports?from=2027-02-01&to=2027-01-01')).status, 400);
  const csv = (qs) => a.get(`/api/projects/1/reports/export?format=csv&${qs}`).then((r) => r.data.toString('utf8').split('\r\n').filter(Boolean));
  const full = await csv('');
  const futureOnly = await csv(`from=${day(1)}`);
  assert.ok(full.length > 2);
  assert.equal(futureOnly.length, 1, 'only the header remains');
  const folderRows = await csv('folder=Web');
  assert.ok(folderRows.some((l) => /R web,.*,1,1,0,0,0,100%/.test(l)), folderRows.join('\n'));
});

// ---------------- bulk edit ----------------
test('bulk edit cases: priority, status and label modes, versions noted, rules respected', async () => {
  const mk = async (title, extra) => (await a.post('/api/projects/1/cases', { title, ...extra })).data.id;
  const ids = [await mk('B1', { labels: 'a, b', priority: 'Low' }), await mk('B2', { labels: 'B, c', priority: 'Low' }), await mk('B3', { priority: 'Low', status: 'Approved' })];
  const bulk = (fields, who = a, list = ids) => who.post('/api/projects/1/cases/bulk', { ids: list, action: 'update', fields });
  const get = async (id) => (await a.get(`/api/cases/${id}`)).data;
  assert.equal((await bulk({})).status, 400, 'nothing chosen');
  assert.equal((await bulk({ priority: 'Urgent' })).status, 400);
  assert.equal((await bulk({ labels: { mode: 'merge', value: 'x' } })).status, 400);
  assert.equal((await bulk({ priority: 'High' }, vic.client)).status, 403);
  assert.equal((await bulk({ priority: 'High', status: 'Draft' })).data.count, 3);
  assert.deepEqual((await Promise.all(ids.map(get))).map((c) => [c.priority, c.status]), [['High', 'Draft'], ['High', 'Draft'], ['High', 'Draft']]);
  assert.equal((await a.get(`/api/cases/${ids[0]}/versions`)).data[0].note, 'Bulk edit');
  await bulk({ labels: { mode: 'add', value: 'new, A' } });
  assert.deepEqual((await Promise.all(ids.map(get))).map((c) => c.labels), ['a, b, new', 'B, c, new, A', 'new, A'], 'adding skips labels already there (ignoring case)');
  await bulk({ labels: { mode: 'remove', value: 'b, NEW' } });
  assert.deepEqual((await Promise.all(ids.map(get))).map((c) => c.labels), ['a', 'c, A', 'A']);
  await bulk({ labels: { mode: 'set', value: 'only' } });
  assert.deepEqual((await Promise.all(ids.map(get))).map((c) => c.labels), ['only', 'only', 'only']);
  await bulk({ labels: { mode: 'set', value: '' } });
  assert.equal((await get(ids[0])).labels, '', 'set with nothing clears the labels');
  const versions = (await a.get(`/api/cases/${ids[0]}/versions`)).data.length;
  await bulk({ priority: 'High' });
  assert.equal((await a.get(`/api/cases/${ids[0]}/versions`)).data.length, versions, 'no change, no new version');
  const other = (await a.post('/api/projects', { name: 'Other', key: 'OTH' })).data;
  const foreign = (await a.post(`/api/projects/${other.id}/cases`, { title: 'Foreign', priority: 'Low' })).data.id;
  assert.equal((await bulk({ priority: 'High' }, a, [foreign, ids[0]])).data.count, 1, 'cases from other projects are ignored');
  assert.equal((await get(foreign)).priority, 'Low');
  await a.ok('PUT', '/api/projects/1/workflow', { strictApproval: true });
  assert.equal((await bulk({ status: 'Approved' }, tess.client)).status, 403, 'strict approval applies to bulk edits too');
  assert.equal((await bulk({ status: 'Approved' }, a)).data.count, 3, 'admins may');
  await a.ok('PUT', '/api/projects/1/workflow', { strictApproval: false });
});

test('bulk edit bugs: status, severity, priority and assignee, with the usual notifications', async () => {
  const mk = async (title) => (await a.post('/api/projects/1/bugs', { title, severity: 'Minor' })).data.id;
  const ids = [await mk('Bulk A'), await mk('Bulk B')];
  const bulk = (body, who = a) => who.post('/api/projects/1/bugs/bulk', { ids, ...body });
  assert.equal((await bulk({})).status, 400);
  assert.equal((await bulk({ status: 'Nope' })).status, 400);
  assert.equal((await bulk({ status: 'Closed' }, vic.client)).status, 403);
  assert.equal((await bulk({ severity: 'Critical', status: 'In Progress', assignee_id: tess.id })).data.count, 2);
  for (const id of ids) {
    const b = (await a.get(`/api/bugs/${id}`)).data;
    assert.deepEqual([b.severity, b.status, b.assignee_name], ['Critical', 'In Progress', 'TESS']);
  }
  const told = (await tess.client.get('/api/notifications')).data.items.filter((x) => x.kind === 'bug-assigned' && /Bulk [AB]/.test(x.title));
  assert.equal(told.length, 2, 'the new assignee hears about each bug');
  await bulk({ assignee_id: null });
  assert.equal((await a.get(`/api/bugs/${ids[0]}`)).data.assignee_name, null, 'null unassigns');
  await bulk({ priority: 'High' });
  assert.equal((await a.get(`/api/bugs/${ids[0]}`)).data.assignee_name, null, 'an omitted assignee is left alone');
  assert.equal((await a.get(`/api/bugs/${ids[1]}`)).data.priority, 'High');
  const other = (await a.post('/api/projects', { name: 'Other 2', key: 'OT2' })).data;
  const foreign = (await a.post(`/api/projects/${other.id}/bugs`, { title: 'Elsewhere' })).data.id;
  assert.equal((await a.post('/api/projects/1/bugs/bulk', { ids: [foreign, ids[0]], status: 'Resolved' })).data.count, 1);
  assert.equal((await a.get(`/api/bugs/${foreign}`)).data.status, 'Open');
});
