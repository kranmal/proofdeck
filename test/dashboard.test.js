'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startAdmin, addUser } = require('./helpers');

// a tiny mail server that keeps the messages
function fakeSmtp() {
  const mails = [];
  const server = net.createServer((sock) => {
    let buf = '', data = null, rcpt = '';
    const send = (x) => sock.write(`${x}\r\n`);
    send('220 fake');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (data !== null) { const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return; mails.push({ to: rcpt, raw: buf.slice(0, end) }); buf = buf.slice(end + 5); data = null; send('250 ok'); continue; }
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        if (/^EHLO/i.test(line)) send('250 8BITMIME'); else if (/^MAIL/i.test(line)) send('250 ok');
        else if (/^RCPT/i.test(line)) { rcpt = /<(.*)>/.exec(line)[1]; send('250 ok'); } else if (/^DATA/i.test(line)) { data = ''; send('354 go'); }
        else if (/^QUIT/i.test(line)) { send('221 bye'); sock.end(); } else send('502 no');
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, mails, close: () => server.close() })));
}
const body = (m) => Buffer.from(m.raw.split('\r\n\r\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8');
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };

let ctx, a, tess, smtp;
before(async () => {
  smtp = await fakeSmtp();
  ctx = await startAdmin({ NOTIFY_TICK_MS: '100', PUBLIC_URL: 'https://pd.example.com' });
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  await a.ok('PUT', '/api/settings/notifications', { smtp: { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'pd@example.com' }, publicUrl: 'https://pd.example.com', digestHour: 0 });
  await tess.client.ok('PUT', '/api/auth/profile', { email: 'tess@example.com' });
});
after(() => { smtp.close(); ctx.server.stop(); });

test('the dashboard lists what is waiting for you, what you did, and the team trend', async () => {
  const empty = (await tess.client.get('/api/projects/1/dashboard')).data;
  assert.deepEqual([empty.runs.length, empty.bugs.length, empty.reviews.length], [0, 0, 0]);
  assert.equal(empty.teamWeekly.length, 8);
  // give tess work: two runs in a cycle with a past due date, a bug, a review
  const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const cy = (await a.post('/api/projects/1/cycles', { name: 'Tess cycle', due_date: past, caseIds: [1, 2, 3] })).data;
  const runs = (await a.get(`/api/cycles/${cy.id}`)).data.executions;
  for (const r of runs.slice(0, 2)) await a.ok('PUT', `/api/executions/${r.id}`, { assignee_id: tess.id });
  const bug = (await a.post('/api/projects/1/bugs', { title: 'Tess bug', actual: 'x', severity: 'Critical' })).data;
  await a.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: tess.id });
  const draft = (await a.post('/api/projects/1/cases', { title: 'Needs eyes', steps: [{ action: 'a', expected: 'b' }] })).data;
  await a.ok('POST', `/api/cases/${draft.id}/review`, { action: 'request', reviewer_id: tess.id });
  await tess.client.ok('PUT', `/api/executions/${runs[0].id}`, { status: 'Pass' });
  await tess.client.ok('PUT', `/api/executions/${runs[2].id}`, { status: 'Fail' });
  const d = (await tess.client.get('/api/projects/1/dashboard')).data;
  assert.equal(d.runs.length, 1, 'the one she has not run yet');
  assert.deepEqual([d.runs[0].overdue, d.overdueRuns], [true, 1], 'overdue against her own date');
  assert.deepEqual([d.bugs.length, d.bugs[0].severity], [1, 'Critical']);
  assert.equal(d.reviews.length, 1);
  assert.deepEqual([d.doneLastWeek.pass, d.doneLastWeek.fail, d.doneLastWeek.total], [1, 1, 2], 'she ran two');
  assert.equal(d.teamLastWeek.total, 2);
  assert.equal(d.done14.reduce((n, x) => n + x.pass + x.fail, 0), 2);
  assert.equal((await a.get('/api/projects/1/dashboard')).data.runs.length, 0, 'someone else sees their own');
});

test('the weekly email: needs an address and something to say, then arrives with links', async () => {
  assert.equal((await a.post('/api/auth/weekly-report/send', {})).status, 400, 'the admin has no email');
  await tess.client.ok('POST', '/api/auth/weekly-report/send', {});
  const m = await until(() => smtp.mails.find((x) => x.to === 'tess@example.com' && /week/i.test(x.raw)));
  const text = body(m);
  assert.match(text, /Hello TESS, here is your week in Proofdeck/);
  assert.match(text, /Waiting for you: 1 test run \(1 overdue\), 1 open bug, 1 test case to review/);
  assert.match(text, /https:\/\/pd\.example\.com\/#\/run\/\d+/);
  assert.match(text, /You ran 2 tests in the last 7 days \(1 passed, 1 failed, 0 blocked\)/);
  assert.match(text, /The team ran 2, pass rate 50%/);
});

test('the scheduled job sends once to people who opted in, on their Monday, and not again that week', async () => {
  const c2 = await startAdmin({ NOTIFY_TICK_MS: '100', NOTIFY_WEEKLY_ANYDAY: '1', PUBLIC_URL: 'https://pd.example.com' });
  try {
    const a2 = c2.admin, t2 = await addUser(c2.server, a2, 'tess', 'tester'), quiet = await addUser(c2.server, a2, 'quin', 'tester');
    await a2.ok('PUT', '/api/settings/notifications', { smtp: { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'pd@example.com' }, publicUrl: 'https://pd.example.com', digestHour: 0 });
    for (const [u, mail] of [[t2, 'tess2@example.com'], [quiet, 'quin@example.com']]) await u.client.ok('PUT', '/api/auth/profile', { email: mail });
    const bug = (await a2.post('/api/projects/1/bugs', { title: 'Weekly bug', actual: 'x' })).data;
    await a2.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: t2.id });
    await new Promise((r) => setTimeout(r, 700));
    const weekly = (to) => smtp.mails.filter((m) => m.to === to && /here is your week in Proofdeck/.test(body(m)));
    assert.equal(weekly('tess2@example.com').length, 0, 'not opted in yet');
    await t2.client.ok('PUT', '/api/auth/profile', { weekly_report: true });
    const m = await until(() => weekly('tess2@example.com')[0]);
    assert.match(body(m), /1 open bug/);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(weekly('tess2@example.com').length, 1, 'once, not on every tick');
    assert.equal(weekly('quin@example.com').length, 0, 'people who did not opt in get nothing');
  } finally { c2.server.stop(); }
});
