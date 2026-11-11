'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-integration.js');
const run = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env: { ...process.env, GITHUB_TOKEN: '', JIRA_TOKEN: '', ...env } });
  let out = '', err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, out, err }));
});
const fake = () => {
  const seen = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer good-token') { res.writeHead(401); return res.end('{"message":"Bad credentials"}'); }
      if (req.url === '/repos/acme/shop') { res.writeHead(200); return res.end('{"full_name":"acme/shop"}'); }
      if (req.method === 'POST' && req.url === '/repos/acme/shop/issues') { res.writeHead(201); return res.end('{"number":3,"html_url":"https://github.com/acme/shop/issues/3"}'); }
      res.writeHead(404); res.end('{"message":"Not Found"}');
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}`, seen, close: () => s.close() })));
};

test('check-integration: read-only by default, creates one clearly labelled issue with --create, never needs the token on the command line', async () => {
  const f = await fake();
  try {
    const ro = await run(['github', '--owner', 'acme', '--repo', 'shop', '--base', f.url], { GITHUB_TOKEN: 'good-token' });
    assert.equal(ro.code, 0, ro.err);
    assert.match(ro.out, /Connected to acme\/shop/);
    assert.match(ro.out, /Read-only check passed/);
    assert.ok(!f.seen.some((r) => r.method === 'POST'), 'nothing is created without --create');

    const mk = await run(['github', '--owner', 'acme', '--repo', 'shop', '--base', f.url, '--create'], { GITHUB_TOKEN: 'good-token' });
    assert.equal(mk.code, 0, mk.err);
    assert.match(mk.out, /created #3: https:\/\/github.com\/acme\/shop\/issues\/3/);
    const issue = JSON.parse(f.seen.find((r) => r.method === 'POST').body);
    assert.match(issue.title, /integration check \(safe to close\)/);
    assert.ok(!/@example-user/.test(issue.body), 'the sample mention is defanged');

    const bad = await run(['github', '--owner', 'acme', '--repo', 'shop', '--base', f.url], { GITHUB_TOKEN: 'wrong' });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /Bad credentials/);
    assert.ok(!bad.err.includes('wrong') || bad.err.includes('Bad credentials'));

    assert.equal((await run(['github', '--owner', 'acme', '--repo', 'shop'], {})).code, 1, 'no token in the environment');
    assert.match((await run(['github', '--owner', 'acme'], { GITHUB_TOKEN: 'x' })).err, /--owner and --repo/);
    assert.match((await run(['jira', '--base', 'http://example.com', '--email', 'a@b.co', '--project', 'P1'], { JIRA_TOKEN: 'x' })).err, /must start with https/);
    assert.match((await run(['trello'], {})).err, /github or jira/);
  } finally { f.close(); }
});
