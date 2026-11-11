'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a;
before(async () => { ctx = await startAdmin(); a = ctx.admin; });
after(() => ctx.server.stop());

const mk = async (title, extra = {}) => (await a.post('/api/projects/1/cases', { title, steps: [{ action: 'x', expected: 'y' }], ...extra })).data;
const links = async (id) => (await a.get(`/api/cases/${id}`)).data.links;
async function runWith(caseId, status) {
  const c = (await a.post('/api/projects/1/cycles', { name: `run ${caseId} ${status}`, caseIds: [caseId] })).data;
  const ex = (await a.get(`/api/cycles/${c.id}`)).data.executions[0];
  for (const s of (await a.get(`/api/executions/${ex.id}`)).data.steps) await a.ok('PUT', `/api/step-results/${s.id}`, { status });
}

test('links are cleaned: trimmed, de-duplicated ignoring case, blanks dropped, urls checked', async () => {
  const c = await mk('Linked');
  await a.ok('PUT', `/api/cases/${c.id}`, { links: [{ ref: ' PROJ-1 ', title: ' Login ' }, { ref: 'proj-1' }, { ref: '   ' }, { ref: 'PAY-7', url: 'https://example.com/pay/7' }] });
  const l = await links(c.id);
  assert.deepEqual(l.map((x) => [x.ref, x.title]), [['PROJ-1', 'Login'], ['PAY-7', '']]);
  assert.equal(l[1].href, 'https://example.com/pay/7');
  assert.equal(l[0].href, '', 'no connection configured, so no address is guessed');
  for (const bad of ['javascript:alert(1)', 'ftp://x', 'example.com', 'https://a b']) {
    assert.equal((await a.put(`/api/cases/${c.id}`, { links: [{ ref: 'R-1', url: bad }] })).status, 400, bad);
  }
  assert.equal((await a.put(`/api/cases/${c.id}`, { links: Array.from({ length: 31 }, (_, i) => ({ ref: `R-${i}` })) })).status, 400);
  assert.equal((await a.put(`/api/cases/${c.id}`, { links: 'nope' })).status, 400);
  assert.equal((await links(c.id)).length, 2, 'refused saves change nothing');
  await a.ok('PUT', `/api/cases/${c.id}`, { title: 'Linked, renamed' });
  assert.equal((await links(c.id)).length, 2, 'a save without links leaves them alone');
  await a.ok('PUT', `/api/cases/${c.id}`, { links: [] });
  assert.equal((await links(c.id)).length, 0);
  const v = (await a.get(`/api/cases/${c.id}/versions`)).data.length;
  assert.equal(v, 2, 'links are not part of the versioned content (create + rename only)');
});

test('addresses are derived from the Jira / GitHub connection', async () => {
  await a.ok('PUT', '/api/projects/1/integrations/jira', { config: { base: 'http://127.0.0.1:9/jira', email: 'a@b.co', projectKey: 'PROJ' }, token: 't' });
  await a.ok('PUT', '/api/projects/1/integrations/github', { config: { owner: 'acme', repo: 'shop' }, token: 't' });
  const c = await mk('Derived', { links: [{ ref: 'proj-42' }, { ref: '#17' }, { ref: 'Some doc' }, { ref: 'PROJ-9', url: 'https://wiki.example.com/p9' }] });
  const l = await links(c.id);
  assert.equal(l[0].href, 'http://127.0.0.1:9/jira/browse/PROJ-42');
  assert.equal(l[1].href, 'https://github.com/acme/shop/issues/17');
  assert.equal(l[2].href, '');
  assert.equal(l[3].href, 'https://wiki.example.com/p9', 'an explicit address wins');
});

test('clone copies links; deleting the case removes them; the list can be searched by requirement', async () => {
  const c = await mk('Source', { links: [{ ref: 'REQ-5', title: 'Five' }] });
  const copy = (await a.post(`/api/cases/${c.id}/clone`)).data;
  assert.deepEqual((await links(copy.id)).map((x) => x.ref), ['REQ-5']);
  const list = (await a.get('/api/projects/1/cases')).data;
  assert.equal(list.find((x) => x.id === c.id).refs, 'REQ-5');
  await a.ok('DELETE', `/api/cases/${copy.id}`);
  assert.equal((await a.get('/api/projects/1/traceability')).data.requirements.find((r) => r.ref === 'REQ-5').cases.length, 1);
});

test('traceability: coverage status per requirement, uncovered cases, deprecated ignored', async () => {
  const pass = await mk('Passes', { links: [{ ref: 'COV-1', title: 'Covered' }, { ref: 'COV-3' }] });
  const fail = await mk('Fails', { links: [{ ref: 'COV-2' }, { ref: 'COV-3' }] });
  const never = await mk('Never run', { links: [{ ref: 'COV-4' }] });
  const old = await mk('Old', { status: 'Deprecated', links: [{ ref: 'COV-5' }] });
  await runWith(pass.id, 'Pass');
  await runWith(fail.id, 'Fail');
  const t = (await a.get('/api/projects/1/traceability')).data;
  const by = Object.fromEntries(t.requirements.map((r) => [r.ref, r]));
  assert.equal(by['COV-1'].status, 'Passing');
  assert.equal(by['COV-1'].title, 'Covered');
  assert.equal(by['COV-2'].status, 'Failing');
  assert.equal(by['COV-3'].status, 'Failing', 'one failing case fails the requirement');
  assert.equal(by['COV-3'].cases.length, 2);
  assert.equal(by['COV-4'].status, 'Not run');
  assert.ok(!by['COV-5'], 'deprecated cases do not count');
  assert.ok(t.uncovered.some((c) => c.key === 'DEMO-T1'), 'seed cases without links are uncovered');
  assert.ok(!t.uncovered.some((c) => c.id === pass.id));
  assert.equal(t.summary.failing, t.requirements.filter((r) => r.status === 'Failing').length);
  assert.ok(never.id && old.id);
  const csv = (await a.get('/api/projects/1/traceability/export?format=csv')).data.toString('utf8').split('\r\n').filter(Boolean);
  assert.equal(csv[0], '﻿Requirement,Title,Coverage,Test case,Test case title,Last result,Open bugs');
  assert.ok(csv.some((l) => l.startsWith('COV-2,') && l.includes('Failing') && l.includes('Fail')));
  assert.ok(csv.some((l) => l.startsWith('(no requirement),') && l.includes('Uncovered')));
});

test('a requirement is partly run when only some of its cases passed; blocked beats partly run', async () => {
  const p = await mk('Part pass', { links: [{ ref: 'MIX-1' }] }), n = await mk('Part never', { links: [{ ref: 'MIX-1' }] });
  await runWith(p.id, 'Pass');
  const find = async () => (await a.get('/api/projects/1/traceability')).data.requirements.find((r) => r.ref === 'MIX-1');
  assert.equal((await find()).status, 'Partly run');
  await runWith(n.id, 'Blocked');
  assert.equal((await find()).status, 'Blocked');
});

test('viewers can read coverage but not change links', async () => {
  const viewer = await addUser(ctx.server, a, 'vic', 'viewer');
  assert.equal((await viewer.client.get('/api/projects/1/traceability')).status, 200);
  assert.equal((await viewer.client.put('/api/cases/1', { links: [{ ref: 'X-1' }] })).status, 403);
  assert.equal((await a.get('/api/projects/99/traceability')).status, 404);
});
