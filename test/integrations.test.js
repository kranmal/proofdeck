'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startAdmin, addUser } = require('./helpers');

const GH_TOKEN = 'ghp_SuperSecretToken123';
const JIRA_TOKEN = 'jira_api_token_XYZ789';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// A tiny fake of the bits of the GitHub and Jira Cloud APIs we call. It records every request.
function mock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const rec = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(rec);
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      handler(rec, send);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() })));
}

const githubMock = () => mock((r, send) => {
  if (r.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: 'Bad credentials' });
  if (r.method === 'GET' && r.url === '/repos/acme/shop') return send(200, { full_name: 'acme/shop' });
  if (r.method === 'POST' && r.url === '/repos/acme/shop/issues') {
    if (JSON.parse(r.body).title.includes('FAIL422')) return send(422, { message: 'Validation Failed' });
    return send(201, { number: 7, html_url: 'https://github.com/acme/shop/issues/7' });
  }
  return send(404, { message: 'Not Found' });
});

const jiraMock = () => mock((r, send) => {
  const expected = 'Basic ' + Buffer.from(`jira@example.com:${JIRA_TOKEN}`).toString('base64');
  if (r.headers.authorization !== expected) return send(401, { errorMessages: ['You are not authenticated'] });
  if (r.url === '/rest/api/3/myself') return send(200, { displayName: 'Jira Bot' });
  if (r.url === '/rest/api/3/project/PROJ') return send(200, { key: 'PROJ', name: 'Project X' });
  if (r.url.startsWith('/rest/api/3/project/')) return send(404, { errorMessages: ['No project could be found'] });
  if (r.method === 'POST' && r.url === '/rest/api/3/issue') {
    const f = JSON.parse(r.body).fields;
    if (f.project.key !== 'PROJ') return send(400, { errors: { project: 'valid project is required' } });
    return send(201, { id: '10001', key: 'PROJ-12' });
  }
  if (r.method === 'POST' && r.url === '/rest/api/3/issue/PROJ-12/attachments') {
    if (r.headers['x-atlassian-token'] !== 'no-check' || !/^multipart\/form-data/.test(r.headers['content-type'])) return send(403, { message: 'XSRF check failed' });
    return send(200, [{ id: '1' }]);
  }
  return send(404, { message: 'nope' });
});

let ctx, gh, jira, tester, viewer, bugId;
before(async () => {
  ctx = await startAdmin();
  gh = await githubMock();
  jira = await jiraMock();
  tester = await addUser(ctx.server, ctx.admin, 'tess', 'tester');
  viewer = await addUser(ctx.server, ctx.admin, 'vic', 'viewer');
  // A failed step with a bug that has two screenshots and some awkward text.
  const t = tester.client;
  const ex = (await t.get('/api/executions/2')).data;
  await t.ok('PUT', `/api/step-results/${ex.steps[1].id}`, { status: 'Fail', actual: 'Badge shows 0\nPing @octocat about it' });
  await t.ok('POST', `/api/step-results/${ex.steps[1].id}/attachments`, { filename: 'one.png', mime: 'image/png', data: PNG });
  await t.ok('POST', `/api/step-results/${ex.steps[1].id}/attachments`, { filename: 'two.png', mime: 'image/png', data: PNG });
  bugId = (await t.ok('POST', `/api/step-results/${ex.steps[1].id}/bug`, {
    title: 'Cart badge not updated', severity: 'Critical', steps_to_reproduce: '1. Open product\n2. Press "Add to cart"\n\n3. Look at the badge',
  })).id;
});
after(() => { gh.close(); jira.close(); ctx.server.stop(); });

const ghConfig = () => ({ config: { base: gh.url, owner: 'acme', repo: 'shop', labels: ['bug', 'from-proofdeck'] }, token: GH_TOKEN });
const jiraConfig = () => ({ config: { base: jira.url, email: 'jira@example.com', projectKey: 'proj', issueType: 'Bug', labels: ['qa team'] }, token: JIRA_TOKEN });

test('only admins can manage connections; nobody can read a token back', async () => {
  const { admin } = ctx;
  assert.equal((await tester.client.put('/api/projects/1/integrations/github', ghConfig())).status, 403);
  assert.equal((await tester.client.del('/api/projects/1/integrations/github')).status, 403);
  assert.equal((await tester.client.post('/api/projects/1/integrations/github/test', ghConfig())).status, 403);
  assert.equal((await admin.put('/api/projects/1/integrations/github', ghConfig())).status, 200);
  assert.equal((await admin.put('/api/projects/1/integrations/jira', jiraConfig())).status, 200);
  for (const who of [admin, tester.client]) {
    const list = (await who.get('/api/projects/1/integrations')).data;
    assert.deepEqual(list.map((i) => i.kind), ['github', 'jira']);
    const text = JSON.stringify(list);
    assert.ok(!text.includes(GH_TOKEN) && !text.includes(JIRA_TOKEN), 'token never leaves the server');
    assert.equal(list[1].config.projectKey, 'PROJ', 'project key is upper-cased');
  }
});

test('tokens are encrypted on disk', async () => {
  const files = fs.readdirSync(ctx.server.dir).filter((f) => f.startsWith('proofdeck.db'));
  assert.ok(files.length >= 1);
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(ctx.server.dir, f));
    assert.equal(bytes.indexOf(GH_TOKEN), -1, `${f} contains the GitHub token`);
    assert.equal(bytes.indexOf(JIRA_TOKEN), -1, `${f} contains the Jira token`);
  }
  const key = path.join(ctx.server.dir, 'secret.key');
  assert.ok(fs.existsSync(key));
  assert.equal(fs.statSync(key).mode & 0o077, 0, 'key file is private to the owner');
});

test('settings are validated', async () => {
  const { admin } = ctx;
  const put = (kind, config, token = 'tok') => admin.put(`/api/projects/1/integrations/${kind}`, { config, token });
  assert.equal((await put('github', { base: 'http://api.example.com', owner: 'a', repo: 'b' })).status, 400, 'plain http to a real host');
  assert.equal((await put('github', { base: 'https://user:pw@api.example.com', owner: 'a', repo: 'b' })).status, 400, 'credentials in URL');
  assert.equal((await put('github', { base: 'ftp://x', owner: 'a', repo: 'b' })).status, 400);
  assert.equal((await put('github', { owner: 'a b', repo: 'c' })).status, 400, 'bad owner');
  assert.equal((await put('jira', { base: 'https://x.atlassian.net', email: 'nope', projectKey: 'PROJ' })).status, 400, 'bad email');
  assert.equal((await put('jira', { base: 'https://x.atlassian.net', email: 'a@b.c', projectKey: '1bad' })).status, 400, 'bad project key');
  const r = await admin.put('/api/projects/1/integrations/jira', { config: { ...jiraConfig().config } });
  assert.equal(r.status, 200, 'token can be left blank once saved');
  assert.equal((await admin.put('/api/projects/9/integrations/github', ghConfig())).status, 404);
});

test('test connection reports success and failure without leaking the token', async () => {
  const { admin } = ctx;
  const ok = await admin.post('/api/projects/1/integrations/github/test', ghConfig());
  assert.equal(ok.data.message, 'Connected to acme/shop');
  const bad = await admin.post('/api/projects/1/integrations/github/test', { ...ghConfig(), token: 'wrong-token-value' });
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /Bad credentials/);
  assert.match(bad.data.error, /Check the token/);
  assert.ok(!bad.data.error.includes('wrong-token-value'));
  const saved = await admin.post('/api/projects/1/integrations/github/test', { config: ghConfig().config });
  assert.equal(saved.data.ok, true, 'falls back to the saved token');
  const j = await admin.post('/api/projects/1/integrations/jira/test', jiraConfig());
  assert.equal(j.data.message, 'Connected as Jira Bot · project PROJ (Project X)');
  const noProject = await admin.post('/api/projects/1/integrations/jira/test', { ...jiraConfig(), config: { ...jiraConfig().config, projectKey: 'NOPE' } });
  assert.equal(noProject.status, 502);
  assert.match(noProject.data.error, /No project could be found/);
  const down = await admin.post('/api/projects/1/integrations/github/test', { config: { ...ghConfig().config, base: 'http://127.0.0.1:1' }, token: 'x' });
  assert.equal(down.status, 502);
  assert.match(down.data.error, /could not be reached/);
});

test('sending a bug to GitHub creates an issue with the right content, once', async () => {
  const t = tester.client;
  gh.requests.length = 0;
  const r = await t.post(`/api/bugs/${bugId}/push`, { kind: 'github' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.key, '#7');
  assert.equal(r.data.url, 'https://github.com/acme/shop/issues/7');
  assert.match(r.data.note, /cannot upload images/);
  const req = gh.requests.find((x) => x.method === 'POST');
  assert.equal(req.headers.authorization, `Bearer ${GH_TOKEN}`);
  assert.equal(req.headers['x-github-api-version'], '2022-11-28');
  const issue = JSON.parse(req.body);
  assert.equal(issue.title, 'Cart badge not updated');
  assert.deepEqual(issue.labels, ['bug', 'from-proofdeck', 'severity: critical']);
  assert.match(issue.body, /\*\*Severity:\*\* Critical/);
  assert.match(issue.body, /### Steps to reproduce\n1\. Open product\n2\. Press "Add to cart"/);
  assert.match(issue.body, /### Expected result\nCart badge shows 1/);
  assert.match(issue.body, /Badge shows 0/);
  assert.ok(!/@octocat/.test(issue.body) && /@​octocat/.test(issue.body), '@mentions are defanged');
  assert.match(issue.body, /2 screenshots are attached to DEMO-B1 in Proofdeck/);
  const bug = (await t.get(`/api/bugs/${bugId}`)).data;
  assert.deepEqual(bug.links.map((l) => [l.kind, l.external_key, l.url]), [['github', '#7', 'https://github.com/acme/shop/issues/7']]);
  const again = await t.post(`/api/bugs/${bugId}/push`, { kind: 'github' });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already sent \(#7\)/);
  assert.equal(gh.requests.filter((x) => x.method === 'POST').length, 1, 'no second issue was created');
});

test('sending a bug to Jira sends valid ADF, sanitized labels and every screenshot', async () => {
  const t = tester.client;
  jira.requests.length = 0;
  const r = await t.post(`/api/bugs/${bugId}/push`, { kind: 'jira' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.key, 'PROJ-12');
  assert.equal(r.data.url, `${jira.url}/browse/PROJ-12`);
  assert.equal(r.data.note, '');
  const create = jira.requests.find((x) => x.method === 'POST' && x.url === '/rest/api/3/issue');
  const f = JSON.parse(create.body).fields;
  assert.deepEqual(f.project, { key: 'PROJ' });
  assert.deepEqual(f.issuetype, { name: 'Bug' });
  assert.equal(f.summary, 'Cart badge not updated');
  assert.deepEqual(f.labels, ['proofdeck', 'severity-critical', 'qa-team']);
  assert.equal(f.description.type, 'doc');
  assert.equal(f.description.version, 1);
  const textNodes = [];
  (function walk(n) { if (n.type === 'text') textNodes.push(n.text); (n.content || []).forEach(walk); })(f.description);
  assert.ok(textNodes.length > 5 && textNodes.every((x) => x.length > 0), 'ADF has no empty text nodes');
  assert.ok(textNodes.includes('1. Open product') && textNodes.includes('3. Look at the badge'));
  const headings = f.description.content.filter((n) => n.type === 'heading').map((n) => n.content[0].text);
  assert.deepEqual(headings, ['Steps to reproduce', 'Expected result', 'Actual result']);
  const uploads = jira.requests.filter((x) => x.url === '/rest/api/3/issue/PROJ-12/attachments');
  assert.equal(uploads.length, 2, 'both screenshots uploaded');
  assert.ok(uploads.every((u) => u.body.includes('filename="one.png"') || u.body.includes('filename="two.png"')));
  const bug = (await t.get(`/api/bugs/${bugId}`)).data;
  assert.deepEqual(bug.links.map((l) => l.kind), ['github', 'jira']);
});

test('upstream errors surface clearly and leave the bug unlinked so it can be retried', async () => {
  const t = tester.client;
  const b2 = (await t.ok('POST', '/api/projects/1/bugs', { title: 'FAIL422 something' })).id;
  const r = await t.post(`/api/bugs/${b2}/push`, { kind: 'github' });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Validation Failed \(HTTP 422\)/);
  assert.equal((await t.get(`/api/bugs/${b2}`)).data.links.length, 0);
  await ctx.admin.ok('PUT', '/api/projects/1/integrations/jira', { config: { ...jiraConfig().config, projectKey: 'WRONG' } });
  const j = await t.post(`/api/bugs/${b2}/push`, { kind: 'jira' });
  assert.equal(j.status, 502);
  assert.match(j.data.error, /valid project is required/);
  assert.equal((await t.get(`/api/bugs/${b2}`)).data.links.length, 0);
  await ctx.admin.ok('PUT', '/api/projects/1/integrations/jira', jiraConfig());
  assert.equal((await t.post(`/api/bugs/${b2}/push`, { kind: 'jira' })).status, 200, 'works after fixing the config');
});

test('permissions and edge cases for pushing', async () => {
  assert.equal((await viewer.client.post(`/api/bugs/${bugId}/push`, { kind: 'jira' })).status, 403);
  assert.equal((await tester.client.post(`/api/bugs/${bugId}/push`, { kind: 'trello' })).status, 400);
  const other = (await ctx.admin.ok('POST', '/api/projects', { name: 'Other', key: 'OTH' })).id;
  const b = (await ctx.admin.ok('POST', `/api/projects/${other}/bugs`, { title: 'x' })).id;
  const r = await ctx.admin.post(`/api/bugs/${b}/push`, { kind: 'github' });
  assert.equal(r.status, 404, 'connections are per project');
  assert.match(r.data.error, /not set up for this project/);
  await ctx.admin.ok('DELETE', '/api/projects/1/integrations/github');
  assert.deepEqual((await ctx.admin.get('/api/projects/1/integrations')).data.map((i) => i.kind), ['jira']);
});
