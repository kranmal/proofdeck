'use strict';
// Test helpers: start an isolated Proofdeck server (own temp database, random port) and talk to it with a cookie-keeping client.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

async function startServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofdeck-test-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + log)), 10000);
    const onData = (d) => {
      log += d;
      const m = /running at (http:\/\/\S+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${log}`)); });
  });
  return {
    base, dir,
    stop({ keep = false } = {}) { child.removeAllListeners('exit'); child.kill(); if (!keep) fs.rmSync(dir, { recursive: true, force: true }); },
    logs: () => log,
  };
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }

  async request(method, url, body, headers = {}) {
    const res = await fetch(this.base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) {
      if (c.startsWith('pd_session=')) this.cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }

  get(url) { return this.request('GET', url); }
  post(url, body = {}) { return this.request('POST', url, body); }
  put(url, body = {}) { return this.request('PUT', url, body); }
  del(url) { return this.request('DELETE', url); }

  // Like request() but throws unless the status is 2xx; returns the parsed body.
  async ok(method, url, body) {
    const r = await this.request(method, url, body);
    if (r.status < 200 || r.status > 299) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
}

// A fresh server with the first admin created and signed in.
async function startAdmin(env) {
  const server = await startServer(env);
  const admin = new Client(server.base);
  await admin.ok('POST', '/api/auth/setup', { username: 'admin', display_name: 'Ada Admin', password: 'correct horse battery' });
  return { server, admin };
}

// Create a user as admin and return a client signed in as them.
async function addUser(server, admin, username, role, password = 'password-for-' + username) {
  const { id } = await admin.ok('POST', '/api/users', { username, display_name: username.toUpperCase(), role, password });
  const client = new Client(server.base);
  await client.ok('POST', '/api/auth/login', { username, password });
  return { id, client, password };
}

// Raw http request, for headers fetch() will not let us set (Origin).
function rawRequest(base, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { startServer, startAdmin, addUser, Client, rawRequest };
