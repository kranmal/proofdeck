'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startAdmin } = require('./helpers');

// Fake Linear (GraphQL), Azure DevOps (REST + JSON Patch) and GitLab (REST) with real, changeable issue state.
const LIN = 'lin_api_secret_token', ADO = 'ado_pat_secret', GLT = 'glpat_secret';
const body = (r) => new Promise((resolve) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve(Buffer.concat(c))); });
const send = (res, s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const serve = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() })); });

const lin = { issues: {}, next: 41, calls: [] };
const linearServer = () => serve(async (req, res) => {
  if (req.headers.authorization !== LIN) return send(res, 401, { errors: [{ message: 'Authentication required' }] });
  const { query, variables } = JSON.parse((await body(req)).toString());
  lin.calls.push({ query, variables });
  if (/viewer/.test(query)) return send(res, 200, { data: { viewer: { name: 'Lin Bot', email: 'lin@example.com' } } });
  if (/teams\(/.test(query)) return send(res, 200, { data: { teams: { nodes: variables.key === 'ENG' ? [{ id: 'team-1', name: 'Engineering', key: 'ENG' }] : [] } } });
  if (/issueCreate/.test(query)) { const n = lin.next++; lin.issues[`ENG-${n}`] = { id: `id-${n}`, type: 'unstarted' }; return send(res, 200, { data: { issueCreate: { success: true, issue: { id: `id-${n}`, identifier: `ENG-${n}`, url: `https://linear.app/x/issue/ENG-${n}` } } } }); }
  if (/issueUpdate/.test(query)) { const it = Object.values(lin.issues).find((i) => i.id === variables.id); it.type = { 's-done': 'completed', 's-prog': 'started', 's-todo': 'unstarted' }[variables.input.stateId]; return send(res, 200, { data: { issueUpdate: { success: true } } }); }
  if (/states/.test(query)) { const it = lin.issues[variables.id]; return it ? send(res, 200, { data: { issue: { id: it.id, team: { states: { nodes: [{ id: 's-todo', name: 'Todo', type: 'unstarted' }, { id: 's-prog', name: 'In Progress', type: 'started' }, { id: 's-done', name: 'Done', type: 'completed' }] } } } } }) : send(res, 200, { data: { issue: null } }); }
  if (/state\{/.test(query)) { const it = lin.issues[variables.id]; return it ? send(res, 200, { data: { issue: { state: { name: { unstarted: 'Todo', started: 'In Progress', completed: 'Done' }[it.type], type: it.type } } } }) : send(res, 200, { data: { issue: null } }); }
  send(res, 200, { errors: [{ message: 'unsupported query in the fake' }] });
});

const ado_ = { items: {}, next: 500, created: [], attachments: 0 };
const STATES = [{ name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }, { name: 'Resolved', category: 'Resolved' }, { name: 'Closed', category: 'Completed' }];
const azureServer = () => serve(async (req, res) => {
  if (req.headers.authorization !== `Basic ${Buffer.from(`:${ADO}`).toString('base64')}`) return send(res, 401, { message: 'TF400813: not authorized' });
  const u = new URL(req.url, 'http://x'); let m;
  if (req.method === 'GET' && u.pathname === '/org/_apis/projects/Shop') return send(res, 200, { name: 'Shop' });
  if (req.method === 'POST' && u.pathname === '/org/Shop/_apis/wit/attachments') { await body(req); ado_.attachments++; return send(res, 201, { url: `http://x/attach/${ado_.attachments}` }); }
  if (req.method === 'POST' && (m = /^\/org\/Shop\/_apis\/wit\/workitems\/\$(\w+)$/.exec(u.pathname))) {
    assert.equal(req.headers['content-type'], 'application/json-patch+json');
    const ops = JSON.parse((await body(req)).toString()); const id = ado_.next++;
    ado_.items[id] = { type: m[1], state: 'New' }; ado_.created.push({ id, type: m[1], ops });
    return send(res, 200, { id, _links: { html: { href: `https://dev.azure.com/org/Shop/_workitems/edit/${id}` } } });
  }
  if ((m = /^\/org\/Shop\/_apis\/wit\/workitemtypes\/(\w+)\/states$/.exec(u.pathname))) return send(res, 200, { value: STATES });
  if ((m = /^\/org\/Shop\/_apis\/wit\/workitems\/(\d+)$/.exec(u.pathname))) {
    const it = ado_.items[m[1]]; if (!it) return send(res, 404, { message: 'TF401232: Work item does not exist' });
    if (req.method === 'GET') return send(res, 200, { fields: { 'System.State': it.state, 'System.WorkItemType': it.type } });
    if (req.method === 'PATCH') { const ops = JSON.parse((await body(req)).toString()); it.state = ops[0].value; return send(res, 200, {}); }
  }
  send(res, 404, { message: 'nope' });
});

const gl = { issues: {}, next: 7, created: [], uploads: 0 };
const gitlabServer = () => serve(async (req, res) => {
  if (req.headers['private-token'] !== GLT) return send(res, 401, { message: '401 Unauthorized' });
  const u = new URL(req.url, 'http://x'); let m;
  const P = '/api/v4/projects/acme%2Fshop';
  if (req.method === 'GET' && u.pathname === P) return send(res, 200, { path_with_namespace: 'acme/shop' });
  if (req.method === 'POST' && u.pathname === `${P}/uploads`) { await body(req); gl.uploads++; return send(res, 201, { markdown: `![shot${gl.uploads}](/uploads/abc/shot${gl.uploads}.png)` }); }
  if (req.method === 'POST' && u.pathname === `${P}/issues`) { const b = JSON.parse((await body(req)).toString()); const iid = gl.next++; gl.issues[iid] = { state: 'opened' }; gl.created.push({ iid, ...b }); return send(res, 201, { iid, web_url: `https://gitlab.example/acme/shop/-/issues/${iid}` }); }
  if ((m = /^\/api\/v4\/projects\/acme%2Fshop\/issues\/(\d+)$/.exec(u.pathname))) {
    const it = gl.issues[m[1]]; if (!it) return send(res, 404, { message: '404 Not found' });
    if (req.method === 'GET') return send(res, 200, it);
    if (req.method === 'PUT') { const b = JSON.parse((await body(req)).toString()); it.state = b.state_event === 'close' ? 'closed' : 'opened'; return send(res, 200, it); }
  }
  send(res, 404, { message: '404 Not found' });
});

let ctx, a, srv = {};
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
before(async () => {
  srv = { linear: await linearServer(), azure: await azureServer(), gitlab: await gitlabServer() };
  ctx = await startAdmin();
  a = ctx.admin;
});
after(() => { Object.values(srv).forEach((s) => s.close()); ctx.server.stop(); });

const bug = async (title) => {
  const ex = (await a.get('/api/executions/2')).data;
  await a.ok('PUT', `/api/step-results/${ex.steps[0].id}`, { status: 'Fail', actual: 'it broke @someone' });
  const b = (await a.post(`/api/step-results/${ex.steps[0].id}/bug`, { title })).data;
  await a.ok('POST', `/api/bugs/${b.id}/attachments`, { filename: 's.png', mime: 'image/png', data: PNG });
  return b;
};
const links = async (id) => (await a.get(`/api/bugs/${id}`)).data.links;

test('configuration for the new trackers is validated and the token is never returned', async () => {
  const put = (kind, config, token = 'x') => a.put(`/api/projects/1/integrations/${kind}`, { config, token });
  assert.equal((await put('linear', { teamKey: 'not a key!' })).status, 400);
  assert.equal((await put('azure', { base: 'ftp://x', project: 'Shop' })).status, 400);
  assert.equal((await put('azure', { base: srv.azure.url + '/org', project: 'Sh<op>' })).status, 400);
  assert.equal((await put('gitlab', { base: srv.gitlab.url, project: 'has space' })).status, 400);
  assert.equal((await a.put('/api/projects/1/integrations/gitlab', { config: { base: srv.gitlab.url, project: 'acme/shop' } })).status, 400, 'a token is required');
  await a.ok('PUT', '/api/projects/1/integrations/linear', { config: { base: srv.linear.url, teamKey: 'eng' }, token: LIN });
  await a.ok('PUT', '/api/projects/1/integrations/azure', { config: { base: srv.azure.url + '/org', project: 'Shop', workItemType: 'Bug', labels: 'web' }, token: ADO });
  await a.ok('PUT', '/api/projects/1/integrations/gitlab', { config: { base: srv.gitlab.url, project: 'acme/shop' }, token: GLT });
  const list = (await a.get('/api/projects/1/integrations')).data;
  assert.deepEqual(list.map((i) => i.kind).sort(), ['azure', 'gitlab', 'linear']);
  assert.equal(list.find((i) => i.kind === 'linear').config.teamKey, 'ENG');
  assert.ok(![LIN, ADO, GLT].some((t) => JSON.stringify(list).includes(t)));
});

test('test buttons: each says who and what it connected to, and bad tokens or teams are explained', async () => {
  const t = (kind, config, token) => a.post(`/api/projects/1/integrations/${kind}/test`, { config, token });
  assert.match((await t('linear', { base: srv.linear.url, teamKey: 'ENG' }, LIN)).data.message, /Connected as Lin Bot · team ENG \(Engineering\)/);
  assert.match((await t('azure', { base: srv.azure.url + '/org', project: 'Shop' }, ADO)).data.message, /Connected to project Shop/);
  assert.match((await t('gitlab', { base: srv.gitlab.url, project: 'acme/shop' }, GLT)).data.message, /Connected to acme\/shop/);
  const bad = await t('linear', { base: srv.linear.url, teamKey: 'ENG' }, 'wrong-token');
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /Linear said: Authentication required/);
  assert.ok(!bad.data.error.includes('wrong-token'));
  assert.match((await t('linear', { base: srv.linear.url, teamKey: 'NOPE' }, LIN)).data.error, /no team with the key NOPE/);
  assert.match((await t('azure', { base: srv.azure.url + '/org', project: 'Shop' }, 'bad')).data.error, /TF400813.*Check the token/);
});

test('Linear: sends an issue with priority from severity, then follows its state both ways', async () => {
  const b = await bug('Linear bug');
  const r = await a.ok('POST', `/api/bugs/${b.id}/push`, { kind: 'linear' });
  assert.match(r.key, /^ENG-\d+$/);
  assert.match(r.url, /^https:\/\/linear\.app\//);
  assert.match(r.note, /Screenshots stay in Proofdeck/);
  const create = lin.calls.find((c) => /issueCreate/.test(c.query)).variables.input;
  assert.deepEqual([create.teamId, create.title, create.priority], ['team-1', 'Linear bug', 2]);
  assert.match(create.description, /\*\*Found by:\*\* DEMO-T2 step 1/);
  assert.ok(!create.description.includes('@someone') || create.description.includes('@​someone'), 'mentions are defused');
  // pull: the issue is completed in Linear
  lin.issues[r.key].type = 'completed';
  await a.ok('POST', `/api/bugs/${b.id}/sync`, {});
  assert.equal((await a.get(`/api/bugs/${b.id}`)).data.status, 'Resolved');
  assert.equal((await links(b.id))[0].external_label, 'Done');
  // push: reopen in Proofdeck, with push on
  await a.ok('PUT', '/api/projects/1/integrations/linear', { config: { base: srv.linear.url, teamKey: 'ENG', sync: { pull: true, push: true } } });
  await a.ok('PUT', `/api/bugs/${b.id}`, { status: 'In Progress' });
  await new Promise((r2) => setTimeout(r2, 400));
  assert.equal(lin.issues[r.key].type, 'started');
  await a.ok('PUT', `/api/bugs/${b.id}`, { status: 'Closed' });
  await new Promise((r2) => setTimeout(r2, 400));
  assert.equal(lin.issues[r.key].type, 'completed');
});

test('Azure DevOps: work item with fields, tags, priority and attachments; state follows the workflow categories', async () => {
  const b = await bug('Azure bug');
  const r = await a.ok('POST', `/api/bugs/${b.id}/push`, { kind: 'azure' });
  assert.match(r.url, /_workitems\/edit\/\d+/);
  assert.equal(r.note, '');
  const made = ado_.created.find((c) => String(c.id) === r.key);
  const f = (name) => (made.ops.find((o) => o.path === `/fields/${name}`) || {}).value;
  assert.deepEqual([made.type, f('System.Title'), f('Microsoft.VSTS.Common.Priority')], ['Bug', 'Azure bug', 2]);
  assert.match(f('Microsoft.VSTS.TCM.ReproSteps'), /<b>Found by:<\/b> DEMO-T2 step 1/);
  assert.match(f('System.Tags'), /proofdeck; severity-major; web/);
  assert.equal(made.ops.filter((o) => o.path === '/relations/-').length, 1, 'the screenshot is attached');
  assert.ok(!/<script/i.test(JSON.stringify(made.ops)));
  ado_.items[r.key].state = 'Closed';
  await a.ok('POST', `/api/bugs/${b.id}/sync`, {});
  assert.equal((await a.get(`/api/bugs/${b.id}`)).data.status, 'Resolved');
  ado_.items[r.key].state = 'Active';
  await a.ok('POST', `/api/bugs/${b.id}/sync`, {});
  assert.equal((await a.get(`/api/bugs/${b.id}`)).data.status, 'In Progress');
  await a.ok('PUT', '/api/projects/1/integrations/azure', { config: { base: srv.azure.url + '/org', project: 'Shop', sync: { pull: true, push: true } } });
  await a.ok('PUT', `/api/bugs/${b.id}`, { status: 'Closed' });
  await new Promise((r2) => setTimeout(r2, 400));
  assert.equal(ado_.items[r.key].state, 'Closed');
});

test('GitLab: screenshots become uploads embedded in the description; state is open or closed', async () => {
  const b = await bug('GitLab bug');
  const r = await a.ok('POST', `/api/bugs/${b.id}/push`, { kind: 'gitlab' });
  assert.match(r.key, /^#\d+$/);
  assert.equal(r.note, '');
  const made = gl.created.find((c) => `#${c.iid}` === r.key);
  assert.match(made.description, /### Screenshots\n!\[shot1\]\(\/uploads\/abc\/shot1\.png\)/);
  assert.equal(made.labels, 'bug,severity::major');
  gl.issues[made.iid].state = 'closed';
  await a.ok('POST', `/api/bugs/${b.id}/sync`, {});
  assert.equal((await a.get(`/api/bugs/${b.id}`)).data.status, 'Resolved');
  await a.ok('PUT', '/api/projects/1/integrations/gitlab', { config: { base: srv.gitlab.url, project: 'acme/shop', sync: { pull: true, push: true } } });
  await a.ok('PUT', `/api/bugs/${b.id}`, { status: 'Open' });
  await new Promise((r2) => setTimeout(r2, 400));
  assert.equal(gl.issues[made.iid].state, 'opened');
  assert.equal((await a.post(`/api/bugs/${b.id}/push`, { kind: 'gitlab' })).status, 409, 'not sent twice');
});

test('only GitHub and Jira offer webhooks; the others are polled', async () => {
  assert.equal((await a.get('/api/projects/1/integrations/linear/webhook')).status, 404);
  assert.equal((await a.get('/api/projects/1/integrations/gitlab/webhook')).status, 404);
});
