'use strict';
// Jira Server / Data Center: REST v2, personal access token (Bearer), wiki-markup descriptions.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startAdmin } = require('./helpers');

const PAT = 'NjQ0Mjg3NzQ1ODQ5OktWc2lG-server-pat';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let ctx, jira, requests, state, bugId;
before(async () => {
  requests = [];
  state = { status: 'Open', cat: 'new' };
  jira = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        const send = (st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.headers.authorization !== `Bearer ${PAT}`) return send(401, { errorMessages: ['You are not authenticated'] });
        // everything lives under a context path, as on many self-hosted installs
        const u = req.url.replace(/^\/jira/, '');
        if (u === '/rest/api/2/myself') return send(200, { name: 'svc-proofdeck', displayName: 'Service Account' });
        if (u === '/rest/api/2/project/SRV') return send(200, { key: 'SRV', name: 'Server project' });
        if (req.method === 'POST' && u === '/rest/api/2/issue') return send(201, { id: '1', key: 'SRV-5' });
        if (req.method === 'POST' && u === '/rest/api/2/issue/SRV-5/attachments') return send(200, [{ id: '1' }]);
        if (u.startsWith('/rest/api/2/issue/SRV-5?')) return send(200, { fields: { status: { name: state.status, statusCategory: { key: state.cat } } } });
        if (req.method === 'GET' && u === '/rest/api/2/issue/SRV-5/transitions') return send(200, { transitions: [{ id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }] });
        if (req.method === 'POST' && u === '/rest/api/2/issue/SRV-5/transitions') { state = { status: 'Done', cat: 'done' }; res.writeHead(204); return res.end(); }
        return send(404, { message: 'nope' });
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}/jira`, close: () => s.close() }));
  });
  ctx = await startAdmin();
  const ex = (await ctx.admin.get('/api/executions/2')).data;
  await ctx.admin.ok('PUT', `/api/step-results/${ex.steps[1].id}`, { status: 'Fail', actual: 'Total shows {panel} and [x] | y' });
  await ctx.admin.ok('POST', `/api/step-results/${ex.steps[1].id}/attachments`, { filename: 'one.png', mime: 'image/png', data: PNG });
  bugId = (await ctx.admin.ok('POST', `/api/step-results/${ex.steps[1].id}/bug`, { title: 'Server bug', steps_to_reproduce: '1. open\n* odd line\nh1. not a heading' })).id;
});
after(() => { jira.close(); ctx.server.stop(); });

const cfg = (extra = {}) => ({ config: { variant: 'server', base: jira.url, projectKey: 'srv', issueType: 'Bug', ...extra }, token: PAT });

test('server edition needs no email, cloud still does, and the edition is remembered', async () => {
  const put = (c) => ctx.admin.put('/api/projects/1/integrations/jira', c);
  assert.equal((await put({ config: { base: jira.url, projectKey: 'SRV' }, token: PAT })).status, 400, 'cloud (the default) requires the email');
  assert.equal((await put(cfg())).status, 200);
  const saved = (await ctx.admin.get('/api/projects/1/integrations')).data.find((i) => i.kind === 'jira').config;
  assert.equal(saved.variant, 'server');
  assert.equal(saved.email, '');
  assert.equal(saved.projectKey, 'SRV');
  assert.equal(saved.base, jira.url, 'a context path is kept');
});

test('test connection uses a Bearer token against REST v2', async () => {
  requests.length = 0;
  const r = await ctx.admin.post('/api/projects/1/integrations/jira/test', cfg());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.message || r.data.note || JSON.stringify(r.data), /Service Account.*SRV.*Server \/ Data Center/);
  assert.ok(requests.every((x) => x.url.startsWith('/jira/rest/api/2/') && x.headers.authorization === `Bearer ${PAT}`));
  const bad = await ctx.admin.post('/api/projects/1/integrations/jira/test', { ...cfg(), token: 'wrong-token-value' });
  assert.equal(bad.status, 502);
  assert.ok(!JSON.stringify(bad.data).includes('wrong-token-value'));
});

test('sending a bug creates a wiki-markup issue with escaped test data, and attaches the screenshot', async () => {
  requests.length = 0;
  const r = await ctx.admin.post(`/api/bugs/${bugId}/push`, { kind: 'jira' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.url, `${jira.url}/browse/SRV-5`);
  const create = requests.find((x) => x.method === 'POST' && x.url === '/jira/rest/api/2/issue');
  assert.ok(create);
  const f = JSON.parse(create.body).fields;
  assert.equal(typeof f.description, 'string', 'v2 takes a string, not ADF');
  assert.match(f.description, /h3\. Steps to reproduce/);
  assert.match(f.description, /\\\* odd line/, 'a leading * would otherwise become a bullet');
  assert.match(f.description, /\\h1\. not a heading/);
  assert.match(f.description, /Total shows \\\{panel\\\} and \\\[x\\\] \\\| y/, 'macros, links and tables are neutralised');
  assert.equal(f.project.key, 'SRV');
  assert.ok(requests.some((x) => x.url === '/jira/rest/api/2/issue/SRV-5/attachments' && x.headers['x-atlassian-token'] === 'no-check'));
});

test('two-way sync works the same way on Server: read the state and close the issue', async () => {
  const sync = await ctx.admin.post(`/api/bugs/${bugId}/sync`, {});
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  const bug = (await ctx.admin.get(`/api/bugs/${bugId}`)).data;
  assert.match(bug.links.find((l) => l.kind === 'jira').external_state, /^open$/i);
  await ctx.admin.ok('PUT', '/api/projects/1/integrations/jira', cfg({ sync: { pull: true, push: true, onClose: 'Resolved', onReopen: 'Open' } }));
  await ctx.admin.ok('PUT', `/api/bugs/${bugId}`, { status: 'Resolved' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(state.status, 'Done', 'a transition to Done was posted');
});
