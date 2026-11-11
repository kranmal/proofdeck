'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a, stepId, bugId;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  stepId = (await a.get('/api/executions/2')).data.steps[0].id;
  bugId = (await a.post('/api/projects/1/bugs', { title: 'Attach to me' })).data.id;
});
after(() => ctx.server.stop());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const b64 = (b) => Buffer.from(b).toString('base64');
const up = (url, filename, mime, bytes) => a.post(url, { filename, mime, data: b64(bytes) });
const stepUrl = () => `/api/step-results/${stepId}/attachments`;

test('logs, PDFs, CSV, JSON, ZIP and video are accepted as attachments', async () => {
  const files = [
    ['run.log', 'text/plain', Buffer.from('2026-11-11 ERROR boom\n')],
    ['data.csv', 'text/csv', Buffer.from('a,b\n1,2\n')],
    ['state.json', 'application/json', Buffer.from('{"ok":true}')],
    ['report.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%fake\n')],
    ['bundle.zip', 'application/zip', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(20)])],
    ['clip.mp4', 'video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)])],
    ['clip.webm', 'video/webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)])],
    ['shot.png', 'image/png', PNG],
  ];
  for (const [name, mime, bytes] of files) assert.equal((await up(stepUrl(), name, mime, bytes)).status, 200, name);
  const ex = (await a.get('/api/executions/2')).data;
  const listed = ex.steps[0].attachments;
  assert.equal(listed.length, 8);
  assert.deepEqual(listed.map((x) => x.mime).slice(0, 2), ['text/plain', 'text/csv']);
  assert.ok(listed.every((x) => x.size > 0 && x.filename));
});

test('dangerous or mislabelled files are refused', async () => {
  const bad = [
    ['x.svg', 'image/svg+xml', '<svg onload="alert(1)"/>'],
    ['x.html', 'text/html', '<script>alert(1)</script>'],
    ['x.js', 'application/javascript', 'alert(1)'],
    ['x.exe', 'application/x-msdownload', 'MZ'],
  ];
  for (const [n, m, c] of bad) assert.equal((await up(stepUrl(), n, m, Buffer.from(c))).status, 400, `${n} (${m})`);
  assert.equal((await up(stepUrl(), 'fake.png', 'image/png', Buffer.from('<html>not a png</html>'))).status, 400, 'html claiming to be png');
  assert.equal((await up(stepUrl(), 'fake.pdf', 'application/pdf', Buffer.from('MZ not a pdf'))).status, 400);
  assert.equal((await up(stepUrl(), 'bin.txt', 'text/plain', Buffer.from([0x68, 0x00, 0x69]))).status, 400, 'binary labelled as text');
  assert.equal((await up(stepUrl(), 'empty.txt', 'text/plain', Buffer.alloc(0))).status, 400);
  const big = await up(stepUrl(), 'huge.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
  assert.equal(big.status, 413, 'images are capped at 10 MB');
});

test('downloads: images and video inline, everything else as an attachment, nothing sniffable', async () => {
  const mk = async (name, mime, bytes) => (await up(`/api/bugs/${bugId}/attachments`, name, mime, bytes)).data.id;
  const png = await mk('shot "one".png', 'image/png', PNG);
  const log = await mk('run.log', 'text/plain', Buffer.from('hello'));
  const pdf = await mk('r.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
  const mp4 = await mk('c.mp4', 'video/mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(8)]));
  const get = async (id) => (await a.get(`/api/attachments/${id}`)).headers;
  assert.match((await get(png)).get('content-disposition'), /^inline; filename="shot _one_\.png"/, 'quotes in names are neutralised');
  assert.match((await get(log)).get('content-disposition'), /^attachment/);
  assert.equal((await get(log)).get('content-type'), 'text/plain; charset=utf-8');
  assert.match((await get(pdf)).get('content-disposition'), /^attachment/);
  assert.match((await get(mp4)).get('content-disposition'), /^inline/);
  for (const id of [png, log, pdf, mp4]) assert.equal((await get(id)).get('x-content-type-options'), 'nosniff');
  assert.equal((await get(png)).get('cache-control'), 'private, no-cache');
  const bug = (await a.get(`/api/bugs/${bugId}`)).data;
  assert.deepEqual(bug.attachments.map((x) => x.mime), ['image/png', 'text/plain', 'application/pdf', 'video/mp4']);
  const anon = new (require('./helpers').Client)(ctx.server.base);
  assert.equal((await anon.get(`/api/attachments/${png}`)).status, 401);
});

test('an image can be replaced in place; other types cannot', async () => {
  const id = (await up(`/api/bugs/${bugId}/attachments`, 'edit-me.png', 'image/png', PNG)).data.id;
  const before = (await a.get(`/api/attachments/${id}`)).data;
  const bigger = Buffer.concat([PNG, Buffer.alloc(64)]);
  assert.equal((await a.put(`/api/attachments/${id}/content`, { mime: 'image/png', data: b64(bigger) })).status, 200);
  const after2 = (await a.get(`/api/attachments/${id}`)).data;
  assert.equal(after2.length, bigger.length);
  assert.notEqual(after2.length, before.length);
  const meta = (await a.get(`/api/bugs/${bugId}`)).data.attachments.find((x) => x.id === id);
  assert.deepEqual([meta.filename, meta.size], ['edit-me.png', bigger.length], 'name kept, size updated');
  assert.equal((await a.put(`/api/attachments/${id}/content`, { mime: 'text/plain', data: b64('hi') })).status, 400, 'cannot turn an image into text');
  assert.equal((await a.put(`/api/attachments/${id}/content`, { mime: 'image/png', data: b64('<html>') })).status, 400);
  const log = (await up(`/api/bugs/${bugId}/attachments`, 'n.log', 'text/plain', Buffer.from('x'))).data.id;
  assert.equal((await a.put(`/api/attachments/${log}/content`, { mime: 'image/png', data: b64(PNG) })).status, 400, 'only images are editable');
  assert.equal((await a.put('/api/attachments/99999/content', { mime: 'image/png', data: b64(PNG) })).status, 404);
  const viewer = await addUser(ctx.server, a, 'vic', 'viewer');
  assert.equal((await viewer.client.put(`/api/attachments/${id}/content`, { mime: 'image/png', data: b64(PNG) })).status, 403);
});
