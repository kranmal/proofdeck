'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startAdmin, addUser, Client } = require('./helpers');

const GH = 'ghp_sync_token', JT = 'jira_sync_token';
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 40)); } };

// Fake GitHub and Jira with real, changeable issue state.
function fakes() {
  const gh = { issues: {}, next: 7, patches: [], fail: new Set() };
  const jira = { issues: {}, next: 12, transitioned: [], noTransitions: false, fail: new Set() };
  const CAT = { new: { name: 'To Do' }, indeterminate: { name: 'In Progress' }, done: { name: 'Done' } };
  const jsonOf = (r) => new Promise((resolve) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve(b ? JSON.parse(b) : {})); });
  const send = (res, s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const mk = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() })); });
  const github = () => mk(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${GH}`) return send(res, 401, { message: 'Bad credentials' });
    const body = req.method === 'GET' ? {} : await jsonOf(req);
    let m;
    if (req.method === 'GET' && req.url === '/repos/acme/shop') return send(res, 200, { full_name: 'acme/shop' });
    if (req.method === 'POST' && req.url === '/repos/acme/shop/issues') { const n = gh.next++; gh.issues[n] = { state: 'open' }; return send(res, 201, { number: n, html_url: `https://github.com/acme/shop/issues/${n}` }); }
    if ((m = /^\/repos\/acme\/shop\/issues\/(\d+)$/.exec(req.url))) {
      const n = Number(m[1]);
      if (gh.fail.has(n) || !gh.issues[n]) return send(res, 404, { message: 'Not Found' });
      if (req.method === 'GET') return send(res, 200, gh.issues[n]);
      if (req.method === 'PATCH') { gh.patches.push({ n, body }); Object.assign(gh.issues[n], body); return send(res, 200, gh.issues[n]); }
    }
    send(res, 404, { message: 'Not Found' });
  });
  const jiraServer = () => mk(async (req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from(`jira@example.com:${JT}`).toString('base64')) return send(res, 401, { errorMessages: ['not authenticated'] });
    const path0 = req.url.split('?')[0];
    let m;
    if (req.method === 'GET' && path0 === '/rest/api/3/myself') return send(res, 200, { displayName: 'Jira Bot' });
    if (req.method === 'GET' && path0 === '/rest/api/3/project/PROJ') return send(res, 200, { key: 'PROJ', name: 'P' });
    if (req.method === 'POST' && path0 === '/rest/api/3/issue') { const key = `PROJ-${jira.next++}`; jira.issues[key] = { cat: 'new' }; return send(res, 201, { key }); }
    if ((m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/attachments)?$/.exec(path0))) {
      const key = m[1], it = jira.issues[key];
      if (!it || jira.fail.has(key)) return send(res, 404, { errorMessages: ['Issue Does Not Exist'] });
      if (!m[2] && req.method === 'GET') return send(res, 200, { fields: { status: { name: CAT[it.cat].name, statusCategory: { key: it.cat } } } });
      if (m[2] === '/attachments') return send(res, 200, []);
      if (m[2] === '/transitions' && req.method === 'GET') {
        if (jira.noTransitions) return send(res, 200, { transitions: [] });
        const t = (id, name, cat) => ({ id, name, to: { name: CAT[cat].name, statusCategory: { key: cat } } });
        return send(res, 200, { transitions: it.cat === 'done' ? [t('31', 'Reopen', 'new')] : [t('11', 'Start progress', 'indeterminate'), t('21', 'Done', 'done')] });
      }
      if (m[2] === '/transitions' && req.method === 'POST') { const b = await jsonOf(req); jira.transitioned.push({ key, id: b.transition.id }); it.cat = { 11: 'indeterminate', 21: 'done', 31: 'new' }[b.transition.id]; return send(res, 204, {}); }
    }
    send(res, 404, { message: 'nope' });
  });
  return { gh, jira, github, jiraServer };
}

let ctx, a, tess, vic, F, ghSrv, jiraSrv;
before(async () => {
  F = fakes();
  ghSrv = await F.github(); jiraSrv = await F.jiraServer();
  ctx = await startAdmin({ NOTIFY_TICK_MS: '100' });
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
  await connect({});
});
after(() => { ghSrv.close(); jiraSrv.close(); ctx.server.stop(); });

const connect = (sync) => Promise.all([
  a.ok('PUT', '/api/projects/1/integrations/github', { config: { base: ghSrv.url, owner: 'acme', repo: 'shop', sync }, token: GH }),
  a.ok('PUT', '/api/projects/1/integrations/jira', { config: { base: jiraSrv.url, email: 'jira@example.com', projectKey: 'PROJ', sync }, token: JT }),
]);
async function linkedBug(kinds = ['github'], title = 'Sync me') {
  const bug = (await a.post('/api/projects/1/bugs', { title, actual: 'x' })).data;
  await a.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: tess.id });
  for (const k of kinds) assert.equal((await a.post(`/api/bugs/${bug.id}/push`, { kind: k })).status, 200);
  return bug;
}
const bugOf = async (id) => (await a.get(`/api/bugs/${id}`)).data;
const keyOf = (b, kind) => b.links.find((l) => l.kind === kind).external_key;
const sync = (id, c = tess.client) => c.post(`/api/bugs/${id}/sync`);

test('pull from GitHub: closing, reopening, comments, notifications, and no repeat when nothing changed', async () => {
  const bug = await linkedBug();
  let b = await bugOf(bug.id);
  const n = Number(keyOf(b, 'github').slice(1));
  assert.deepEqual([b.links[0].external_state, b.status], ['open', 'Open']);
  const before = (await sync(bug.id)).data.links[0];
  assert.equal(before.changed, false);

  F.gh.issues[n].state = 'closed'; F.gh.issues[n].state_reason = 'completed';
  const r = (await sync(bug.id)).data.links[0];
  assert.deepEqual([r.changed, r.from, r.to, r.label], [true, 'Open', 'Resolved', 'closed (completed)']);
  b = await bugOf(bug.id);
  assert.equal(b.status, 'Resolved');
  assert.match(b.comments.at(-1).body, /Status changed from Open to Resolved because #\d+ is now “closed \(completed\)” in GitHub/);
  assert.equal(b.comments.at(-1).author, null, 'a system comment');
  const told = async (c) => (await c.get('/api/notifications')).data.items.filter((x) => x.link === `#/bugs/${bug.id}` && /is now Resolved/.test(x.title));
  assert.equal((await told(tess.client)).length, 1, 'the assignee hears about it');
  assert.equal((await told(a)).length, 1, 'and so does the reporter');
  assert.equal((await sync(bug.id)).data.links[0].changed, false);
  assert.equal((await bugOf(bug.id)).comments.length, 1, 'syncing again adds nothing');

  F.gh.issues[n].state = 'open'; delete F.gh.issues[n].state_reason;
  assert.deepEqual([(await sync(bug.id)).data.links[0].to], ['Open']);
  assert.equal((await bugOf(bug.id)).status, 'Open');
});

test('a local edit is never undone by an old external value; closed-state mapping is configurable', async () => {
  const bug = await linkedBug(['github'], 'Local wins');
  await a.ok('PUT', `/api/bugs/${bug.id}`, { status: 'Resolved' });
  assert.equal((await sync(bug.id)).data.links[0].changed, false, 'the issue is still open, but that is not news');
  assert.equal((await bugOf(bug.id)).status, 'Resolved');

  await connect({ pull: true, onClose: 'Closed', onReopen: 'In Progress' });
  const b2 = await linkedBug(['github'], 'Maps to Closed');
  const n = Number(keyOf(await bugOf(b2.id), 'github').slice(1));
  F.gh.issues[n].state = 'closed';
  assert.equal((await sync(b2.id)).data.links[0].to, 'Closed');
  F.gh.issues[n].state = 'open';
  assert.equal((await sync(b2.id)).data.links[0].to, 'In Progress', 'reopening goes where the admin chose');
  await connect(undefined);
});

test('pull from Jira uses status categories: In Progress, Done, reopened', async () => {
  const bug = await linkedBug(['jira'], 'Jira pull');
  const key = keyOf(await bugOf(bug.id), 'jira');
  F.jira.issues[key].cat = 'indeterminate';
  assert.deepEqual([(await sync(bug.id)).data.links[0].to, (await bugOf(bug.id)).status], ['In Progress', 'In Progress']);
  F.jira.issues[key].cat = 'done';
  assert.equal((await sync(bug.id)).data.links[0].to, 'Resolved');
  F.jira.issues[key].cat = 'new';
  const r = (await sync(bug.id)).data.links[0];
  assert.deepEqual([r.to, r.label], ['Open', 'To Do']);
  const l = (await bugOf(bug.id)).links[0];
  assert.deepEqual([l.external_state, l.external_label, l.sync_error], ['open', 'To Do', '']);
  assert.ok(l.synced_at);
});

test('pull can be switched off per integration: the state is recorded but the bug is left alone', async () => {
  await connect({ pull: false });
  const bug = await linkedBug(['github'], 'No pull');
  const n = Number(keyOf(await bugOf(bug.id), 'github').slice(1));
  F.gh.issues[n].state = 'closed';
  const r = (await sync(bug.id)).data.links[0];
  assert.equal(r.changed, false);
  const b = await bugOf(bug.id);
  assert.deepEqual([b.status, b.links[0].external_state], ['Open', 'done']);
  await connect(undefined);
});

test('failures are recorded on the link and shown, other links still sync, and it recovers', async () => {
  const bug = await linkedBug(['github', 'jira'], 'Partial failure');
  const b = await bugOf(bug.id);
  const n = Number(keyOf(b, 'github').slice(1)), key = keyOf(b, 'jira');
  F.gh.fail.add(n);
  F.jira.issues[key].cat = 'done';
  const r = (await sync(bug.id)).data.links;
  assert.match(r.find((x) => x.kind === 'github').error, /GitHub said: Not Found \(HTTP 404\)/);
  assert.equal(r.find((x) => x.kind === 'jira').to, 'Resolved', 'the other link is unaffected');
  const links = (await bugOf(bug.id)).links;
  assert.match(links.find((x) => x.kind === 'github').sync_error, /Not Found/);
  F.gh.fail.delete(n);
  assert.equal((await sync(bug.id)).data.links.find((x) => x.kind === 'github').error, undefined);
  assert.equal((await bugOf(bug.id)).links.find((x) => x.kind === 'github').sync_error, '', 'cleared on success');
});

test('push: changing the bug status closes and reopens the issue; no echo; opt-in only', async () => {
  const bug = await linkedBug(['github', 'jira'], 'Push me');
  const b = await bugOf(bug.id);
  const n = Number(keyOf(b, 'github').slice(1)), key = keyOf(b, 'jira');
  await a.ok('PUT', `/api/bugs/${bug.id}`, { status: 'Resolved' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(F.gh.issues[n].state, 'open', 'push is off by default');
  assert.equal(F.jira.issues[key].cat, 'new');
  await a.ok('PUT', `/api/bugs/${bug.id}`, { status: 'Open' });

  await connect({ push: true });
  await a.ok('PUT', `/api/bugs/${bug.id}`, { status: 'Resolved' });
  await until(() => F.gh.issues[n].state === 'closed' && F.jira.issues[key].cat === 'done');
  assert.deepEqual(F.gh.patches.at(-1), { n, body: { state: 'closed', state_reason: 'completed' } });
  assert.deepEqual(F.jira.transitioned.at(-1), { key, id: '21' }, 'the transition into the “done” category');
  await until(async () => (await bugOf(bug.id)).links.every((l) => l.external_state === 'done'));
  const synced = (await sync(bug.id)).data.links;
  assert.ok(synced.every((l) => l.changed === false), 'the pull after a push sees nothing new: no echo');
  assert.equal((await bugOf(bug.id)).comments.length, 0);

  await a.ok('PUT', `/api/bugs/${bug.id}`, { status: 'Open' });
  await until(() => F.gh.issues[n].state === 'open' && F.jira.issues[key].cat === 'new');
  assert.deepEqual(F.jira.transitioned.at(-1), { key, id: '31' }, 'Reopen');
  await a.ok('PUT', `/api/bugs/${bug.id}`, { status: 'In Progress' });
  await until(() => F.jira.issues[key].cat === 'indeterminate');
  assert.equal(F.gh.issues[n].state, 'open', 'GitHub has no in-progress state, so it stays open');
  const patches = F.gh.patches.length;
  await a.ok('PUT', `/api/bugs/${bug.id}`, { title: 'Renamed only' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(F.gh.patches.length, patches, 'only status changes are pushed');
  await connect(undefined);
});

test('a push that cannot be done is recorded and the person who changed the status is told', async () => {
  await connect({ push: true });
  const bug = await linkedBug(['jira'], 'Cannot push');
  const key = keyOf(await bugOf(bug.id), 'jira');
  F.jira.noTransitions = true;
  await tess.client.ok('PUT', `/api/bugs/${bug.id}`, { status: 'Resolved' });
  await until(async () => (await bugOf(bug.id)).links[0].sync_error);
  assert.match((await bugOf(bug.id)).links[0].sync_error, /no workflow transition to a “done” status/);
  const note = (await tess.client.get('/api/notifications')).data.items.find((x) => x.kind === 'sync-error');
  assert.match(note.title, new RegExp(`Could not update ${key} in Jira`));
  F.jira.noTransitions = false;
  await connect(undefined);
});

test('sync endpoints: tester can sync a bug, viewers cannot, admins can sync the whole project', async () => {
  const bug = await linkedBug(['github'], 'Perms');
  assert.equal((await sync(bug.id, vic.client)).status, 403);
  const plain = (await a.post('/api/projects/1/bugs', { title: 'Never sent' })).data;
  assert.equal((await sync(plain.id)).status, 400);
  assert.equal((await sync(99999)).status, 404);
  assert.equal((await tess.client.post('/api/projects/1/sync')).status, 403);
  const n = Number(keyOf(await bugOf(bug.id), 'github').slice(1));
  F.gh.issues[n].state = 'closed';
  const all = (await a.post('/api/projects/1/sync')).data;
  assert.ok(all.checked >= 1 && all.changed >= 1);
  assert.equal((await bugOf(bug.id)).status, 'Resolved');
});

const sign = (secret, raw) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const hook = (url, raw, headers = {}) => fetch(ctx.server.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

test('webhooks: GitHub (HMAC) and Jira (HMAC or secret) update bugs at once; forgeries and noise are ignored', async () => {
  assert.equal((await tess.client.get('/api/projects/1/integrations/github/webhook')).status, 403);
  const gw = (await a.get('/api/projects/1/integrations/github/webhook')).data;
  assert.equal(gw.path, '/api/webhooks/github/1');
  assert.ok(gw.secret.length >= 30);
  assert.equal((await a.get('/api/projects/1/integrations/github/webhook')).data.secret, gw.secret, 'stable until regenerated');
  assert.ok(!JSON.stringify((await tess.client.get('/api/projects/1/integrations')).data).includes(gw.secret), 'never in the integrations listing');
  for (const f of fs.readdirSync(ctx.server.dir).filter((x) => x.startsWith('proofdeck.db'))) assert.equal(fs.readFileSync(path.join(ctx.server.dir, f)).indexOf(gw.secret), -1, 'encrypted at rest');

  const bug = await linkedBug(['github', 'jira'], 'Hooked');
  const b = await bugOf(bug.id);
  const num = Number(keyOf(b, 'github').slice(1)), jkey = keyOf(b, 'jira');
  const payload = (action, repo = 'acme/shop', number = num) => JSON.stringify({ action, issue: { number, state_reason: 'completed' }, repository: { full_name: repo } });
  const ev = (e) => ({ 'X-GitHub-Event': e });

  const raw = payload('closed');
  assert.equal((await hook('/api/webhooks/github/1', raw, { ...ev('issues'), 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) })).status, 401, 'wrong signature');
  assert.equal((await hook('/api/webhooks/github/1', raw, ev('issues'))).status, 401, 'no signature');
  assert.equal((await bugOf(bug.id)).status, 'Open');
  const ok = await hook('/api/webhooks/github/1', raw, { ...ev('issues'), 'X-Hub-Signature-256': sign(gw.secret, raw) });
  assert.deepEqual([ok.status, ok.data.changed, ok.data.to], [200, true, 'Resolved']);
  assert.equal((await hook('/api/webhooks/github/1', raw, { ...ev('issues'), 'X-Hub-Signature-256': sign(gw.secret, raw) })).data.changed, false, 'a replay changes nothing');
  const reopen = payload('reopened');
  assert.equal((await hook('/api/webhooks/github/1', reopen, { ...ev('issues'), 'X-Hub-Signature-256': sign(gw.secret, reopen) })).data.to, 'Open');
  const other = payload('closed', 'someone/else');
  assert.match((await hook('/api/webhooks/github/1', other, { ...ev('issues'), 'X-Hub-Signature-256': sign(gw.secret, other) })).data.ignored, /another repository/);
  const unknown = payload('closed', 'acme/shop', 99999);
  assert.match((await hook('/api/webhooks/github/1', unknown, { ...ev('issues'), 'X-Hub-Signature-256': sign(gw.secret, unknown) })).data.ignored, /no bug is linked/);
  assert.equal((await hook('/api/webhooks/github/1', '{}', { ...ev('ping'), 'X-Hub-Signature-256': sign(gw.secret, '{}') })).data.pong, true);
  assert.match((await hook('/api/webhooks/github/1', '{}', { ...ev('push'), 'X-Hub-Signature-256': sign(gw.secret, '{}') })).data.ignored, /event push/);
  assert.equal((await hook('/api/webhooks/github/1', 'not json', { ...ev('issues'), 'X-Hub-Signature-256': sign(gw.secret, 'not json') })).status, 400);
  assert.equal((await hook('/api/webhooks/github/2', raw, { ...ev('issues'), 'X-Hub-Signature-256': sign(gw.secret, raw) })).status, 401, 'another project has no such secret');

  const jw = (await a.get('/api/projects/1/integrations/jira/webhook')).data;
  const jpay = (cat, key = jkey) => JSON.stringify({ webhookEvent: 'jira:issue_updated', issue: { key, fields: { status: { name: cat === 'done' ? 'Done' : 'To Do', statusCategory: { key: cat } } } } });
  const jdone = jpay('done');
  assert.equal((await hook(`${jw.path}?secret=wrong`, jdone)).status, 401);
  const viaSecret = await hook(`${jw.path}?secret=${jw.secret}`, jdone);
  assert.deepEqual([viaSecret.status, viaSecret.data.to], [200, 'Resolved']);
  const jopen = jpay('new');
  assert.equal((await hook(jw.path, jopen, { 'X-Hub-Signature': sign(jw.secret, jopen) })).data.to, 'Open', 'HMAC works for Jira too');
  assert.match((await hook(`${jw.path}?secret=${jw.secret}`, jpay('done', 'PROJ-9999'))).data.ignored, /no bug is linked/);

  const rotated = (await a.post('/api/projects/1/integrations/github/webhook')).data;
  assert.notEqual(rotated.secret, gw.secret);
  assert.equal((await hook('/api/webhooks/github/1', raw, { ...ev('issues'), 'X-Hub-Signature-256': sign(gw.secret, raw) })).status, 401, 'the old secret stops working');
  assert.ok([401, 429].includes((await new Client(ctx.server.base).post('/api/webhooks/github/1', {})).status), 'unsigned calls are refused (or throttled after repeated forgeries)');
  const again = payload('closed');
  assert.equal((await hook('/api/webhooks/github/1', again, { ...ev('issues'), 'X-Hub-Signature-256': sign(rotated.secret, again) })).status, 200, 'a genuine call is never throttled');
});

test('the background poller picks up changes without anyone pressing anything', async () => {
  const f2 = fakes();
  const g = await f2.github();
  const s = await startAdmin({ SYNC_TICK_MS: '150', NOTIFY_TICK_MS: '100' });
  try {
    await s.admin.ok('PUT', '/api/projects/1/integrations/github', { config: { base: g.url, owner: 'acme', repo: 'shop' }, token: GH });
    const bug = (await s.admin.post('/api/projects/1/bugs', { title: 'Auto sync' })).data;
    await s.admin.ok('POST', `/api/bugs/${bug.id}/push`, { kind: 'github' });
    f2.gh.issues[7].state = 'closed';
    await until(async () => (await s.admin.get(`/api/bugs/${bug.id}`)).data.status === 'Resolved', 8000);
    f2.gh.issues[7].state = 'open';
    await until(async () => (await s.admin.get(`/api/bugs/${bug.id}`)).data.status === 'Open', 8000);
  } finally { g.close(); s.server.stop(); }
});
