'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startAdmin, addUser, Client } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'reset-password.js');
const run = (dir, args, input = '') => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], {
  env: { ...process.env, DATA_DIR: dir }, input, encoding: 'utf8',
});

test('a locked-out admin can reset their password from the command line', async () => {
  const { server, admin } = await startAdmin();
  const staleSession = admin.cookie;
  const dir = server.dir;
  server.stop({ keep: true });
  try {
    const r = run(dir, ['admin', '--password-stdin'], 'my brand new password\n');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Password changed for admin/);
    assert.ok(!r.stdout.includes('my brand new password'), 'the password is never echoed');

    const s2 = await startServer({ DATA_DIR: dir });
    try {
      const c = new Client(s2.base);
      assert.equal((await c.post('/api/auth/login', { username: 'admin', password: 'correct horse battery' })).status, 401, 'old password is dead');
      assert.equal((await c.post('/api/auth/login', { username: 'admin', password: 'my brand new password' })).status, 200);
      const old = new Client(s2.base);
      old.cookie = staleSession;
      assert.equal((await old.get('/api/projects')).status, 401, 'old sessions were ended');
    } finally { s2.stop(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('it can re-activate and promote a user, and refuses weak passwords, unknown users and missing databases', async () => {
  const { server, admin } = await startAdmin();
  const u = await addUser(server, admin, 'tess', 'tester');
  await admin.ok('PUT', `/api/users/${u.id}`, { active: false });
  const dir = server.dir;
  server.stop({ keep: true });
  try {
    const list = run(dir, ['--list']);
    assert.equal(list.status, 0);
    assert.match(list.stdout, /tess\s+tester\s+INACTIVE/);
    assert.match(list.stdout, /admin\s+admin\s+active/);

    const weak = run(dir, ['tess', '--password-stdin'], 'short\n');
    assert.equal(weak.status, 1);
    assert.match(weak.stderr, /at least 8 characters.*Nothing was changed/);
    const nobody = run(dir, ['ghost', '--password-stdin'], 'long enough password\n');
    assert.equal(nobody.status, 1);
    assert.match(nobody.stderr, /no user named “ghost”.*admin, tess/);
    const ambiguous = run(dir, ['--password-stdin'], 'long enough password\n');
    assert.equal(ambiguous.status, 1, 'with several users you must name one');
    assert.match(ambiguous.stderr, /say which user/);

    const ok = run(dir, ['tess', '--make-admin', '--activate', '--password-stdin'], 'tess new password\n');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /now an admin.*re-activated/);

    const s2 = await startServer({ DATA_DIR: dir });
    try {
      const c = new Client(s2.base);
      assert.equal((await c.post('/api/auth/login', { username: 'tess', password: 'tess new password' })).status, 200);
      assert.equal((await c.get('/api/auth/me')).data.user.role, 'admin');
    } finally { s2.stop(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'proofdeck-empty-'));
  try {
    const none = run(empty, ['--list']);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no database at/);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('a single-user installation does not need the username', async () => {
  const { server } = await startAdmin();
  const dir = server.dir;
  server.stop({ keep: true });
  try {
    const r = run(dir, ['--password-stdin'], 'another good password\n');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Password changed for admin/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
