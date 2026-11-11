'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, startAdmin, addUser, Client } = require('./helpers');

let ctx, a;
before(async () => { ctx = await startAdmin(); a = ctx.admin; });
after(() => ctx.server.stop());

const versions = async (id) => (await a.get(`/api/cases/${id}/versions`)).data;

test('every case starts at v1, including the seeded demo cases', async () => {
  const demo = await versions(1);
  assert.deepEqual(demo.map((v) => v.version), [1]);
  const made = (await a.post('/api/projects/1/cases', { title: 'Versioned', steps: [{ action: 'a', expected: 'b' }] })).data;
  const vs = await versions(made.id);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].author, 'Ada Admin');
  assert.equal((await a.get(`/api/cases/${made.id}`)).data.version, 1);
});

test('edits that change content create versions; no-op saves and folder moves do not', async () => {
  const id = (await a.post('/api/projects/1/cases', { title: 'Edit me', steps: [{ action: 'one', expected: 'x' }] })).data.id;
  const save = (body) => a.ok('PUT', `/api/cases/${id}`, body);
  assert.equal((await save({ title: 'Edit me' })).version, 1, 'same title: still v1');
  assert.equal((await save({ title: 'Edit me', steps: [{ action: 'one', expected: 'x' }] })).version, 1, 'identical steps: still v1');
  assert.equal((await save({ title: 'Edit me v2' })).version, 2);
  assert.equal((await save({ steps: [{ action: 'one', expected: 'x' }, { action: 'two', expected: 'y' }] })).version, 3);
  assert.equal((await save({ folder: 'Somewhere / Else' })).version, 3, 'folder is organisation, not content');
  assert.equal((await save({ priority: 'High' })).version, 4);
  const vs = await versions(id);
  assert.deepEqual(vs.map((v) => v.version), [4, 3, 2, 1]);
  const v2 = (await a.get(`/api/cases/${id}/versions/2`)).data;
  assert.equal(v2.snapshot.title, 'Edit me v2');
  assert.equal(v2.snapshot.steps.length, 1);
  assert.equal((await a.get(`/api/cases/${id}/versions/9`)).status, 404);
});

test('the author of each version is whoever saved it', async () => {
  const tess = await addUser(ctx.server, a, 'tess', 'tester');
  const id = (await a.post('/api/projects/1/cases', { title: 'Shared' })).data.id;
  await tess.client.ok('PUT', `/api/cases/${id}`, { title: 'Shared, edited by Tess' });
  const vs = await versions(id);
  assert.deepEqual(vs.map((v) => v.author), ['TESS', 'Ada Admin']);
});

test('restoring an old version brings back its content as a new version', async () => {
  const id = (await a.post('/api/projects/1/cases', { title: 'Original', objective: 'obj', steps: [{ action: 'first', expected: 'ok' }] })).data.id;
  await a.ok('PUT', `/api/cases/${id}`, { title: 'Changed', objective: 'new obj', steps: [{ action: 'other', expected: 'meh' }, { action: 'more', expected: 'x' }] });
  const r = (await a.post(`/api/cases/${id}/versions/1/restore`)).data;
  assert.equal(r.version, 3);
  const c = (await a.get(`/api/cases/${id}`)).data;
  assert.equal(c.title, 'Original');
  assert.equal(c.objective, 'obj');
  assert.deepEqual(c.steps.map((s) => s.action), ['first']);
  const vs = await versions(id);
  assert.equal(vs[0].note, 'Restored from v1');
  assert.equal(vs.length, 3, 'history is kept, never rewritten');
  assert.equal((await a.post(`/api/cases/${id}/versions/1/restore`)).data.version, 3, 'restoring what is already current changes nothing');
  assert.equal((await a.post(`/api/cases/${id}/versions/42/restore`)).status, 404);
  const viewer = await addUser(ctx.server, a, 'vic', 'viewer');
  assert.equal((await viewer.client.post(`/api/cases/${id}/versions/1/restore`)).status, 403);
  assert.equal((await viewer.client.get(`/api/cases/${id}/versions`)).status, 200, 'viewers can read history');
});

test('runs remember which version they executed, and flag when the case has moved on', async () => {
  const id = (await a.post('/api/projects/1/cases', { title: 'Run me', steps: [{ action: 'a', expected: 'b' }] })).data.id;
  await a.ok('PUT', `/api/cases/${id}`, { title: 'Run me v2' });
  const cyc = (await a.post('/api/projects/1/cycles', { name: 'Versions', caseIds: [id] })).data;
  const ex = (await a.get(`/api/cycles/${cyc.id}`)).data.executions[0];
  let e = (await a.get(`/api/executions/${ex.id}`)).data;
  assert.equal(e.case_version, 2);
  assert.equal(e.current_version, 2);
  await a.ok('PUT', `/api/cases/${id}`, { title: 'Run me v3' });
  e = (await a.get(`/api/executions/${ex.id}`)).data;
  assert.equal(e.case_title, 'Run me v2', 'the run keeps the title it started with');
  assert.equal(e.case_version, 2);
  assert.equal(e.current_version, 3);
  const run = (await a.post(`/api/cases/${id}/run`)).data;
  assert.equal((await a.get(`/api/executions/${run.executionId}`)).data.case_version, 3);
});

test('clone and import start at v1', async () => {
  const src = (await a.post('/api/projects/1/cases', { title: 'Cloneable' })).data.id;
  await a.ok('PUT', `/api/cases/${src}`, { title: 'Cloneable 2' });
  const copy = (await a.post(`/api/cases/${src}/clone`)).data;
  assert.deepEqual((await versions(copy.id)).map((v) => v.version), [1]);
  const csv = 'Name,Step,Expected Result\nImported thing,do it,done\n';
  const parsed = (await a.post('/api/import/parse', { data: Buffer.from(csv).toString('base64') })).data;
  await a.ok('POST', '/api/projects/1/import', { rows: parsed.rows, mapping: parsed.mapping });
  const imported = (await a.get('/api/projects/1/cases')).data.find((c) => c.title === 'Imported thing');
  assert.deepEqual((await versions(imported.id)).map((v) => v.version), [1]);
});

test('deleting a case removes its history; cases from before versioning are backfilled on start', async () => {
  const id = (await a.post('/api/projects/1/cases', { title: 'Delete me' })).data.id;
  await a.ok('DELETE', `/api/cases/${id}`);
  assert.equal((await a.get(`/api/cases/${id}/versions`)).status, 404);

  // Simulate an old database: wipe the history, then restart the server on the same data.
  const s = await startServer();
  try {
    const c = new Client(s.base);
    await c.ok('POST', '/api/auth/setup', { username: 'admin', password: 'correct horse battery' });
    const caseId = (await c.post('/api/projects/1/cases', { title: 'Legacy case', steps: [{ action: 'x', expected: 'y' }] })).data.id;
    s.stop({ keep: true });
    const db = new DatabaseSync(path.join(s.dir, 'proofdeck.db'));
    db.exec('DELETE FROM case_versions; UPDATE cases SET version=1');
    db.close();
    const s2 = await startServer({ DATA_DIR: s.dir });
    try {
      const c2 = new Client(s2.base);
      await c2.ok('POST', '/api/auth/login', { username: 'admin', password: 'correct horse battery' });
      const vs = (await c2.get(`/api/cases/${caseId}/versions`)).data;
      assert.deepEqual(vs.map((v) => v.version), [1]);
      assert.equal((await c2.get('/api/cases/1/versions')).data.length, 1, 'demo cases too');
    } finally { s2.stop(); }
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});
