'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startAdmin, addUser } = require('./helpers');

let ctx, a, kiri;
before(async () => {
  ctx = await startAdmin({ LIVE_HEARTBEAT_MS: '300' });
  a = ctx.admin;
  kiri = await addUser(ctx.server, a, 'kiri', 'tester');
});
after(() => ctx.server.stop());

// An open event stream that collects what arrives.
async function listen(client) {
  const ac = new AbortController();
  const res = await fetch(`${ctx.server.base}/api/events`, { headers: { Cookie: client.cookie }, signal: ac.signal });
  const stream = { status: res.status, type: res.headers.get('content-type'), events: [], text: '', closed: false, close: () => ac.abort() };
  if (res.status !== 200) return stream;
  (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        stream.text += dec.decode(chunk, { stream: true });
        let i;
        while ((i = stream.text.indexOf('\n\n')) >= 0) {
          const block = stream.text.slice(0, i); stream.text = stream.text.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block), data = /^data: (.*)$/m.exec(block);
          stream.events.push({ event: ev ? ev[1] : '', data: data ? JSON.parse(data[1]) : null, raw: block });
        }
      }
    } catch { /* aborted */ }
    stream.closed = true;
  })();
  return stream;
}
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 30)); } };
const changes = (s) => s.events.filter((e) => e.event === 'change').flatMap((e) => e.data.changes);

test('the stream needs a sign-in and says hello', async () => {
  const anon = await fetch(`${ctx.server.base}/api/events`);
  assert.equal(anon.status, 401);
  const s = await listen(a);
  assert.deepEqual([s.status, s.type], [200, 'text/event-stream; charset=utf-8']);
  await until(() => s.events.some((e) => e.event === 'hello'));
  s.close();
});

test('a saved change is announced with its topic, project and who did it, and never with content', async () => {
  const s = await listen(a);
  await until(() => s.events.some((e) => e.event === 'hello'));
  const r = await kiri.client.post('/api/projects/1/cases', { title: 'SECRET-TITLE-xyz', steps: [{ action: 'a', expected: 'b' }] });
  assert.equal(r.status, 200);
  const c = await until(() => changes(s).find((x) => x.topic === 'cases'));
  assert.deepEqual([c.topic, c.pid, c.actor], ['cases', 1, kiri.id]);
  assert.ok(!JSON.stringify(s.events).includes('SECRET-TITLE-xyz'));
  s.close();
});

test('reads and sign-in calls do not announce anything; a burst is sent as one message', async () => {
  const s = await listen(a);
  await until(() => s.events.some((e) => e.event === 'hello'));
  const before = s.events.length;
  await a.get('/api/projects/1/cases');
  await kiri.client.post('/api/auth/login', { username: 'kiri', password: 'password-for-kiri' });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(s.events.filter((e) => e.event === 'change').length, 0, 'nothing for reads or logins');
  for (let i = 0; i < 5; i++) await kiri.client.post('/api/projects/1/cases', { title: `Burst ${i}`, steps: [{ action: 'a', expected: 'b' }] });
  await until(() => changes(s).length >= 1);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(s.events.filter((e) => e.event === 'change').length <= 2, 'batched');
  assert.equal(changes(s).filter((x) => x.topic === 'cases').length, 1, 'duplicates collapse into one entry');
  s.close();
});

test('a new notification reaches only its owner, at once', async () => {
  const mine = await listen(kiri.client), other = await listen(a);
  await until(() => mine.events.some((e) => e.event === 'hello') && other.events.some((e) => e.event === 'hello'));
  const bug = (await a.post('/api/projects/1/bugs', { title: 'Mention', actual: 'x' })).data;
  await a.ok('POST', `/api/bugs/${bug.id}/comments`, { body: 'please look @kiri' });
  await until(() => mine.events.some((e) => e.event === 'notify'));
  assert.ok(!other.events.some((e) => e.event === 'notify'), 'not sent to someone else');
  assert.ok(bug.id);
  mine.close(); other.close();
});

test('signing out ends the stream', async () => {
  const w = await addUser(ctx.server, a, 'wren', 'viewer');
  const s = await listen(w.client);
  await until(() => s.events.some((e) => e.event === 'hello'));
  await w.client.post('/api/auth/logout', {});
  await until(() => s.events.some((e) => e.event === 'bye') || s.closed);
  await until(() => s.closed);
});

test('one account cannot hold unlimited streams', async () => {
  const w = await addUser(ctx.server, a, 'many', 'viewer');
  const open = [];
  for (let i = 0; i < 8; i++) open.push(await listen(w.client));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(open.filter((s) => !s.closed).length, 6, 'the oldest ones were closed');
  open.forEach((s) => s.close && s.close());
});
