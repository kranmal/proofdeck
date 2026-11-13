'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { startAdmin, addUser } = require('./helpers');

let ctx, a, tess, sink, got, plan;
before(async () => {
  got = []; plan = { status: 200 };
  sink = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: b }); res.statusCode = plan.status; res.end('ok'); });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  ctx = await startAdmin({ WEBHOOK_TICK_MS: '60', WEBHOOK_BACKOFF_MS: '30', PUBLIC_URL: 'https://pd.example.com' });
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
});
after(() => { sink.close(); ctx.server.stop(); });

const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 30)); } };
const url = (path = '/hook') => `http://127.0.0.1:${sink.address().port}${path}`;
const mk = (extra) => a.ok('POST', '/api/projects/1/webhooks', { name: 'Hook', kind: 'slack', url: url(), events: ['run.failed'], ...extra });
const quiet = () => new Promise((r) => setTimeout(r, 400));

test('configuration: admins only, address checked, secrets not shown back', async () => {
  assert.equal((await tess.client.get('/api/projects/1/webhooks')).status, 403);
  assert.equal((await a.post('/api/projects/1/webhooks', { name: 'x', kind: 'slack', url: 'ftp://x', events: ['run.failed'] })).status, 400);
  assert.equal((await a.post('/api/projects/1/webhooks', { name: 'x', kind: 'slack', url: 'https://u:p@x.example', events: ['run.failed'] })).status, 400);
  assert.equal((await a.post('/api/projects/1/webhooks', { name: 'x', kind: 'slack', url: url(), events: [] })).status, 400);
  assert.equal((await a.post('/api/projects/1/webhooks', { name: 'x', kind: 'pager', url: url(), events: ['run.failed'] })).status, 400);
  const { id } = await mk({ name: 'Secret hook', url: url('/services/T000/B000/SECRETTOKEN'), kind: 'generic', signingSecret: 'shh' });
  const list = (await a.get('/api/projects/1/webhooks')).data;
  const item = list.items.find((x) => x.id === id);
  assert.equal(item.host, `127.0.0.1:${sink.address().port}`);
  assert.ok(!JSON.stringify(list).includes('SECRETTOKEN') && !JSON.stringify(list).includes('shh'), 'neither the address path nor the signing secret is returned');
  assert.equal(item.signed, true);
  assert.ok(!ctx.server.logs().includes('SECRETTOKEN'));
  const db = require('node:fs').readFileSync(require('node:path').join(ctx.server.dir, 'proofdeck.db'));
  assert.ok(!db.includes('SECRETTOKEN'), 'stored encrypted');
  await a.ok('DELETE', `/api/webhooks/${id}`);
});

test('a failing run posts a Slack message once, with a link, and only subscribed events fire', async () => {
  got.length = 0;
  const { id } = await mk({ events: ['run.failed'] });
  const ex = (await a.get('/api/executions/2')).data;
  await a.ok('PUT', `/api/step-results/${ex.steps[0].id}`, { status: 'Fail', actual: 'broke' });
  const d = await until(() => got.find((g) => g.url === '/hook'));
  const msg = JSON.parse(d.body);
  assert.match(msg.text, /Test failed: DEMO-T2 Add item to cart/);
  assert.match(msg.text, /https:\/\/pd\.example\.com\/#\/run\/2/);
  await a.ok('PUT', `/api/step-results/${ex.steps[0].id}`, { status: 'Fail', actual: 'still broke' });
  const bug = (await a.post(`/api/step-results/${ex.steps[0].id}/bug`, { title: 'Not subscribed' })).data;
  await quiet();
  assert.equal(got.length, 1, 'no repeat for a run that was already failed, and bug events are not subscribed');
  void bug;
  await a.ok('DELETE', `/api/webhooks/${id}`);
});

test('bug created, bug status changed and cycle completed; Teams and generic formats; HMAC signature', async () => {
  got.length = 0;
  const slack = await mk({ name: 'S', events: ['bug.created', 'bug.status_changed'], url: url('/s') });
  const teams = await mk({ name: 'T', kind: 'teams', events: ['cycle.completed'], url: url('/t') });
  const gen = await mk({ name: 'G', kind: 'generic', events: ['bug.created', 'cycle.completed'], url: url('/g'), signingSecret: 'topsecret' });
  const bug = (await a.post('/api/projects/1/bugs', { title: 'Webhook bug', actual: 'x', severity: 'Critical' })).data;
  await until(() => got.filter((g) => g.url === '/s').length === 1 && got.filter((g) => g.url === '/g').length === 1);
  assert.match(JSON.parse(got.find((g) => g.url === '/s').body).text, /New bug: .* Webhook bug/);
  await a.ok('PUT', `/api/bugs/${bug.id}`, { status: 'Resolved' });
  await until(() => got.filter((g) => g.url === '/s').length === 2);
  assert.match(JSON.parse(got.filter((g) => g.url === '/s')[1].body).text, /moved from Open to Resolved/);

  const g = got.find((x) => x.url === '/g');
  const parsed = JSON.parse(g.body);
  assert.deepEqual([parsed.event, parsed.project.key, parsed.data.title], ['bug.created', 'DEMO', 'Webhook bug']);
  assert.equal(g.headers['x-proofdeck-event'], 'bug.created');
  assert.equal(g.headers['x-proofdeck-signature'], `sha256=${crypto.createHmac('sha256', 'topsecret').update(g.body).digest('hex')}`);

  // finish a whole cycle
  const cy = (await a.post('/api/projects/1/cycles', { name: 'Finish me', caseIds: [1, 3] })).data;
  const runs = (await a.get(`/api/cycles/${cy.id}`)).data.executions;
  await a.ok('PUT', `/api/executions/${runs[0].id}`, { status: 'Pass' });
  await quiet();
  assert.equal(got.filter((x) => x.url === '/t').length, 0, 'not while a run is still open');
  await a.ok('PUT', `/api/executions/${runs[1].id}`, { status: 'Fail' });
  const t = await until(() => got.find((x) => x.url === '/t'));
  const card = JSON.parse(t.body);
  assert.equal(card.type, 'message');
  assert.match(card.attachments[0].content.body[0].text, /Cycle finished: .* Finish me/);
  assert.match(card.attachments[0].content.body[1].text, /1 passed, 1 failed, 0 blocked of 2/);
  await a.ok('PUT', `/api/executions/${runs[1].id}`, { status: 'Pass' });
  await quiet();
  assert.equal(got.filter((x) => x.url === '/t').length, 1, 'changing a finished run does not announce it again');
  for (const id of [slack.id, teams.id, gen.id]) await a.ok('DELETE', `/api/webhooks/${id}`);
});

test('retries with backoff, gives up after five tries, records what happened; test button; inactive hooks stay quiet', async () => {
  got.length = 0; plan.status = 500;
  const { id } = await mk({ events: ['bug.created'], url: url('/retry') });
  await a.ok('POST', '/api/projects/1/bugs', { title: 'Retry me', actual: 'x' });
  await until(async () => (await a.get(`/api/webhooks/${id}/deliveries`)).data[0]?.status === 'failed');
  const del = (await a.get(`/api/webhooks/${id}/deliveries`)).data[0];
  assert.deepEqual([del.attempts, del.response_status, del.last_error], [5, 500, 'The other side answered 500']);
  assert.equal(got.filter((g) => g.url === '/retry').length, 5);
  assert.equal((await a.get('/api/projects/1/webhooks')).data.items.find((x) => x.id === id).last.status, 'failed');

  plan.status = 200; got.length = 0;
  await a.ok('POST', `/api/webhooks/${id}/test`, {});
  const t = await until(() => got.find((g) => g.url === '/retry'));
  assert.match(JSON.parse(t.body).text, /Test from Proofdeck/);
  await a.ok('PUT', `/api/webhooks/${id}`, { active: false });
  got.length = 0;
  await a.ok('POST', '/api/projects/1/bugs', { title: 'Quiet', actual: 'x' });
  await quiet();
  assert.equal(got.length, 0);
  await a.ok('DELETE', `/api/webhooks/${id}`);
});

test('an unreachable address is reported, not fatal', async () => {
  const { id } = await mk({ events: ['bug.created'], url: 'http://127.0.0.1:1/nothing' });
  await a.ok('POST', '/api/projects/1/bugs', { title: 'Nobody home', actual: 'x' });
  await until(async () => (await a.get(`/api/webhooks/${id}/deliveries`)).data[0]?.status === 'failed');
  assert.match((await a.get(`/api/webhooks/${id}/deliveries`)).data[0].last_error, /Could not connect/);
  assert.equal((await a.get('/api/auth/me')).status, 200, 'the server carries on');
});
