'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a, tess, vic;
before(async () => {
  ctx = await startAdmin();
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
});
after(() => ctx.server.stop());

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const inbox = async (c) => (await c.get('/api/notifications')).data.items;

test('comments on a test case: listed, mentions and involved people are told, authors and admins can delete', async () => {
  await a.ok('POST', '/api/cases/1/comments', { body: 'Needs a negative path, @tess can you look?' });
  const c = (await a.get('/api/cases/1')).data;
  assert.equal(c.comments.length, 1);
  assert.equal(c.comments[0].author, 'Ada Admin');
  const t = await inbox(tess.client);
  assert.equal(t[0].kind, 'mention');
  assert.equal(t[0].link, '#/cases/1');
  assert.equal((await inbox(a)).filter((x) => /commented|mentioned/.test(x.title)).length, 0, 'the author is not told');
  await tess.client.ok('POST', '/api/cases/1/comments', { body: 'On it' });
  assert.equal((await inbox(a))[0].kind, 'comment', 'earlier commenters hear about replies');
  assert.equal((await a.post('/api/cases/1/comments', { body: '   ' })).status, 400);
  assert.equal((await a.post('/api/cases/9999/comments', { body: 'x' })).status, 404);
  const mine = (await a.get('/api/cases/1')).data.comments;
  assert.equal((await tess.client.del(`/api/item-comments/${mine[0].id}`)).status, 403, 'not someone else\'s comment');
  await a.ok('DELETE', `/api/item-comments/${mine[1].id}`);
  assert.equal((await a.get('/api/cases/1')).data.comments.length, 1);
});

test('comments and files on an execution, and both go away with their owner', async () => {
  const ex = (await a.get('/api/executions/2')).data;
  assert.deepEqual([ex.comments, ex.attachments], [[], []]);
  await a.ok('PUT', '/api/executions/2', { assignee_id: tess.id });
  await a.ok('POST', '/api/executions/2/comments', { body: 'Flaky on Safari' });
  assert.equal((await inbox(tess.client))[0].link, '#/run/2', 'the assignee is told');
  await a.ok('POST', '/api/executions/2/attachments', { filename: 'shot.png', mime: 'image/png', data: png });
  const after1 = (await a.get('/api/executions/2')).data;
  assert.equal(after1.comments.length, 1);
  assert.equal(after1.attachments.length, 1);
  assert.equal((await a.get(`/api/attachments/${after1.attachments[0].id}`)).headers.get('content-type'), 'image/png');
  assert.equal((await a.post('/api/cases/1/attachments', { filename: 'x.svg', mime: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') })).status, 400);
  await a.ok('POST', '/api/cases/1/attachments', { filename: 'spec.png', mime: 'image/png', data: png });
  assert.equal((await a.get('/api/cases/1')).data.attachments.length, 1);

  await a.ok('DELETE', '/api/executions/2');
  assert.equal((await a.get(`/api/attachments/${after1.attachments[0].id}`)).status, 404, 'files leave with the run');
  await a.ok('DELETE', '/api/cases/1');
  assert.equal((await a.get('/api/cases/1')).status, 404);
});

test('viewers cannot comment', async () => {
  assert.ok([401, 403].includes((await vic.client.post('/api/cases/2/comments', { body: 'hi' })).status));
});
