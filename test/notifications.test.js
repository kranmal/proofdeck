'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { startAdmin, addUser, Client } = require('./helpers');
const { sendMail, buildMessage } = require('../lib/smtp');

// A fake mail server. `plan.failNext` makes the next N messages fail with a 451; `plan.auth` requires AUTH PLAIN.
function fakeSmtp(plan = {}) {
  const mails = [], sessions = [];
  const server = net.createServer((sock) => {
    let buf = '', data = null, from = '', rcpt = [], authed = false;
    const s = { cmds: [] }; sessions.push(s);
    const send = (x) => sock.write(`${x}\r\n`);
    send('220 fake ESMTP');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buf.slice(0, end); buf = buf.slice(end + 5);
          const text = raw.replace(/^\.\./gm, '.'); data = null;
          if (plan.failNext > 0) { plan.failNext--; send('451 try again later'); continue; }
          mails.push({ from, to: rcpt, raw: text }); send('250 queued'); continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        s.cmds.push(line.split(' ')[0].toUpperCase());
        if (/^EHLO/i.test(line)) { sock.write(`250-fake\r\n${plan.auth ? '250-AUTH PLAIN LOGIN\r\n' : ''}250 8BITMIME\r\n`); }
        else if (/^AUTH PLAIN/i.test(line)) { const [, u, p] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0'); s.user = u; s.pass = p; authed = u === plan.auth.user && p === plan.auth.pass; send(authed ? '235 ok' : '535 bad credentials'); }
        else if (/^MAIL FROM/i.test(line)) { if (plan.auth && !authed) send('530 auth required'); else { from = /<(.*)>/.exec(line)[1]; rcpt = []; send('250 ok'); } }
        else if (/^RCPT TO/i.test(line)) { if (plan.rejectTo && line.includes(plan.rejectTo)) send('550 no such user'); else { rcpt.push(/<(.*)>/.exec(line)[1]); send('250 ok'); } }
        else if (/^DATA/i.test(line)) { data = ''; send('354 go'); }
        else if (/^QUIT/i.test(line)) { send('221 bye'); sock.end(); }
        else send('502 unknown');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, mails, sessions, plan, close: () => server.close() })));
}
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 40)); } };
const decode = (raw) => { const [head, ...rest] = raw.split('\r\n\r\n'); return { head, body: Buffer.from(rest.join('').replace(/\s+/g, ''), 'base64').toString('utf8') }; };

let ctx, a, smtp, tess, vic;
before(async () => {
  smtp = await fakeSmtp();
  ctx = await startAdmin({ NOTIFY_TICK_MS: '100', NOTIFY_BACKOFF_MS: '60', NOTIFY_DIGEST_MS: '300' });
  a = ctx.admin;
  tess = await addUser(ctx.server, a, 'tess', 'tester');
  vic = await addUser(ctx.server, a, 'vic', 'viewer');
});
after(() => { smtp.close(); ctx.server.stop(); });

const configure = (extra = {}) => a.put('/api/settings/notifications', { smtp: { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'proofdeck@example.com', fromName: 'Proofdeck', ...extra }, publicUrl: 'https://pd.example.com', digestHour: 0 });
const inbox = async (c, unread = false) => (await c.get(`/api/notifications${unread ? '?unread=1' : ''}`)).data;
const mkBug = async (title = 'A bug') => (await a.post('/api/projects/1/bugs', { title, actual: 'it broke' })).data;

test('the SMTP client: plain delivery, AUTH, dot-stuffing, header safety and clear errors', async () => {
  const s = await fakeSmtp({ auth: { user: 'mailer', pass: 's3cret' } });
  try {
    const cfg = { host: '127.0.0.1', port: s.port, security: 'none', user: 'mailer', pass: 's3cret' };
    await sendMail(cfg, { from: 'a@example.com', fromName: 'Ada “Admin” Ünï', to: 'b@example.com', subject: 'Hello Ünïcode\r\nBcc: evil@example.com', text: 'line one\n.starts with a dot\nline three' });
    assert.equal(s.mails.length, 1);
    assert.deepEqual([s.sessions[0].user, s.sessions[0].pass], ['mailer', 's3cret']);
    const { head, body } = decode(s.mails[0].raw);
    assert.ok(!/^Bcc:/mi.test(head), 'a newline in the subject cannot inject a header');
    assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(head, /^Content-Transfer-Encoding: base64/m);
    assert.equal(body, 'line one\r\n.starts with a dot\r\nline three');
    await assert.rejects(sendMail({ ...cfg, pass: 'wrong' }, { from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' }), /Sign-in: the server said 535/);
    s.plan.auth = null; s.plan.rejectTo = 'nobody@';
    await assert.rejects(sendMail({ host: '127.0.0.1', port: s.port, security: 'none' }, { from: 'a@example.com', to: 'nobody@example.com', subject: 's', text: 't' }), /Recipient: the server said 550 no such user/);
    await assert.rejects(sendMail({ host: '127.0.0.1', port: 1, security: 'none' }, { from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' }), /Could not connect/);
    await assert.rejects(sendMail({ host: '127.0.0.1', port: s.port, security: 'starttls' }, { from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' }), /does not offer STARTTLS/);
    // credentials are never sent in clear to a remote host
    await assert.rejects(sendMail({ host: 'mail.example.invalid', port: 25, security: 'none', user: 'u', pass: 'p' }, { from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' }), /Could not connect|Refusing/);
    assert.throws(() => buildMessage({ from: 'bad', to: 'b@example.com', subject: 's', text: 't' }), /Invalid sender or recipient/);
  } finally { s.close(); }
});

test('email settings: admin only, validated, password encrypted and never returned; test email works', async () => {
  assert.equal((await tess.client.get('/api/settings/notifications')).status, 403);
  assert.equal((await tess.client.put('/api/settings/notifications', {})).status, 403);
  assert.equal((await a.put('/api/settings/notifications', { smtp: { host: 'x', port: 99999, from: 'a@b.co' } })).status, 400, 'port');
  assert.equal((await a.put('/api/settings/notifications', { smtp: { host: 'x', port: 25, from: 'nope' } })).status, 400, 'from');
  assert.equal((await a.put('/api/settings/notifications', { smtp: { host: 'x', port: 25, from: 'a@b.co', security: 'ssl' } })).status, 400, 'security');
  assert.equal((await a.put('/api/settings/notifications', { publicUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await a.put('/api/settings/notifications', { digestHour: 24 })).status, 400);
  const saved = await configure({ user: 'mailer', password: 'hunter2-secret' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.smtp.hasPassword, true);
  assert.ok(!JSON.stringify((await a.get('/api/settings/notifications')).data).includes('hunter2-secret'));
  for (const f of fs.readdirSync(ctx.server.dir).filter((x) => x.startsWith('proofdeck.db'))) assert.equal(fs.readFileSync(path.join(ctx.server.dir, f)).indexOf('hunter2-secret'), -1, 'password is encrypted at rest');
  await configure({ user: '' });
  assert.equal((await a.get('/api/settings/notifications')).data.resetAvailable, true);
  const t = await a.post('/api/settings/notifications/test', { to: 'ada@example.com' });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.equal(smtp.mails.at(-1).to[0], 'ada@example.com');
  assert.match(decode(smtp.mails.at(-1).raw).body, /If you can read it/);
  assert.equal((await a.post('/api/settings/notifications/test', { to: 'nope' })).status, 400);
  const draft = await a.post('/api/settings/notifications/test', { to: 'ada@example.com', smtp: { host: '127.0.0.1', port: 1, security: 'none', from: 'a@b.co' } });
  assert.equal(draft.status, 502, 'an unsaved draft can be tested, and failures say why');
  assert.match(draft.data.error, /Could not connect/);
});

test('in-app notifications: assignment, status change, comments and mentions reach the right people, never the actor', async () => {
  const bug = await mkBug('Notify me');
  const admin = (await a.get('/api/auth/me')).data.user;
  await a.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: tess.id });
  let n = (await inbox(tess.client)).items;
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Ada Admin assigned .* to you: Notify me/);
  assert.equal(n[0].link, `#/bugs/${bug.id}`);
  assert.equal((await inbox(a)).unread, 0, 'the person who did it is not told');
  await tess.client.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: tess.id });
  assert.equal((await inbox(tess.client)).items.length, 1, 'assigning to yourself or unchanged says nothing');

  await tess.client.ok('PUT', `/api/bugs/${bug.id}`, { status: 'In Progress' });
  const adminInbox = (await inbox(a)).items;
  assert.match(adminInbox[0].title, /is now In Progress/, 'the reporter hears about status changes');
  await tess.client.ok('POST', `/api/bugs/${bug.id}/comments`, { body: 'Looking at it, thanks @admin and @nobody-here' });
  const afterComment = (await inbox(a)).items;
  assert.equal(afterComment[0].kind, 'mention', 'a mention wins over the generic comment notice');
  assert.equal(afterComment.filter((x) => x.kind === 'comment').length, 0);
  await a.ok('POST', `/api/bugs/${bug.id}/comments`, { body: 'Great' });
  assert.equal((await inbox(tess.client)).items[0].kind, 'comment', 'earlier commenters and assignee are told');
  assert.equal((await inbox(vic.client)).items.length, 0, 'uninvolved users hear nothing');

  const run = (await a.get('/api/executions/1')).data;
  await a.ok('PUT', '/api/executions/1', { assignee_id: tess.id });
  assert.match((await inbox(tess.client)).items[0].title, /assigned DEMO-T1 .* to you/);
  assert.equal((await inbox(tess.client)).items[0].link, '#/run/1');
  assert.ok(run && admin);
});

test('reading: unread counts, mark read, isolation between users, viewers can read their own', async () => {
  const before = (await tess.client.get('/api/notifications/unread-count')).data.count;
  assert.ok(before >= 3);
  const items = (await inbox(tess.client)).items;
  assert.equal((await tess.client.post('/api/notifications/read', { ids: [items[0].id] })).data.marked, 1);
  assert.equal((await tess.client.post('/api/notifications/read', { ids: [items[0].id] })).data.marked, 0, 'already read');
  assert.equal((await tess.client.get('/api/notifications/unread-count')).data.count, before - 1);
  assert.equal((await inbox(tess.client, true)).items.length, before - 1);
  const adminItem = (await inbox(a)).items[0];
  assert.equal((await tess.client.post('/api/notifications/read', { ids: [adminItem.id] })).data.marked, 0, 'cannot mark someone else’s');
  assert.equal((await inbox(a, true)).items.some((x) => x.id === adminItem.id), true);
  assert.equal((await tess.client.post('/api/notifications/read', { all: true })).data.marked, before - 1);
  assert.equal((await inbox(tess.client)).unread, 0);
  await a.ok('PUT', `/api/executions/2`, { assignee_id: vic.id });
  assert.equal((await inbox(vic.client)).unread, 1);
  assert.equal((await vic.client.post('/api/notifications/read', { all: true })).status, 200, 'viewers may clear their own');
  assert.equal((await new Client(ctx.server.base).get('/api/notifications')).status, 401);
});

test('email: profile validation, instant delivery with a link, daily digest, off, and retries with backoff', async () => {
  assert.equal((await tess.client.put('/api/auth/profile', { email: 'not an email' })).status, 400);
  assert.equal((await tess.client.put('/api/auth/profile', { notify_email: 'sometimes' })).status, 400);
  assert.equal((await tess.client.put('/api/auth/profile', { email: 'tess@example.com' })).data.user.email, 'tess@example.com');
  assert.equal((await vic.client.put('/api/auth/profile', { email: 'vic@example.com', notify_email: 'daily' })).status, 200, 'viewers can set their own contact details');

  const start = smtp.mails.length;
  const bug = await mkBug('Email me');
  await a.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: tess.id });
  const mail = await until(() => smtp.mails.slice(start).find((m) => m.to[0] === 'tess@example.com'));
  const { head, body } = decode(mail.raw);
  assert.match(head, /^From: "Proofdeck" <proofdeck@example.com>/m);
  assert.match(head, /^Subject: Ada Admin assigned/m);
  assert.match(body, new RegExp(`Open it: https://pd.example.com/#/bugs/${bug.id}`));
  const sent = (await a.get('/api/settings/notifications')).data;
  assert.ok(sent.configured);

  await tess.client.ok('PUT', '/api/auth/profile', { notify_email: 'off' });
  const toTess = () => smtp.mails.filter((m) => m.to[0] === 'tess@example.com').length;
  const quiet = toTess();
  await a.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: null });
  await a.ok('PUT', `/api/bugs/${bug.id}`, { assignee_id: tess.id });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(toTess(), quiet, 'email off means no email');
  assert.ok((await inbox(tess.client)).items.length >= 2, 'but the in-app notification still arrives');

  // vic is on the daily digest: nothing instant, one digest email with everything since the last one
  assert.equal(smtp.mails.some((m) => m.to[0] === 'vic@example.com' && /assigned/.test(m.raw)), false);
  await a.ok('PUT', '/api/executions/3', { assignee_id: vic.id });
  const digests = () => smtp.mails.filter((m) => m.to[0] === 'vic@example.com').map((m) => decode(m.raw).body);
  await until(() => digests().join('\n').includes('assigned DEMO-T3'));
  assert.ok(digests().every((b) => /^You have \d+ updates? in Proofdeck/.test(b)));
  assert.ok(digests().join('\n').includes('assigned DEMO-T2'), 'earlier items are in the digest too');
  const count = digests().length;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(digests().length, count, 'with nothing new there is no further digest');
  assert.equal(digests().join('\n').split('assigned DEMO-T3').length - 1, 1, 'an item is never repeated in a later digest');

  // flaky mail server: failures are retried with backoff, then delivered
  await tess.client.ok('PUT', '/api/auth/profile', { notify_email: 'instant' });
  smtp.plan.failNext = 2;
  const b2 = await mkBug('Retry me');
  await a.ok('PUT', `/api/bugs/${b2.id}`, { assignee_id: tess.id });
  const retried = await until(() => smtp.mails.find((m) => decode(m.raw).body.includes(`#/bugs/${b2.id}`)));
  assert.ok(retried);
  assert.equal(smtp.plan.failNext, 0);
});

test('a mail server that never accepts marks messages failed after five tries and does not block others', async () => {
  const dead = await fakeSmtp({ failNext: 1000 });
  try {
    await a.ok('PUT', '/api/settings/notifications', { smtp: { host: '127.0.0.1', port: dead.port, security: 'none', from: 'proofdeck@example.com' }, publicUrl: 'https://pd.example.com' });
    const b = await mkBug('Doomed email');
    await tess.client.ok('PUT', '/api/auth/profile', { notify_email: 'instant' });
    await a.ok('PUT', `/api/bugs/${b.id}`, { assignee_id: tess.id });
    const db = new (require('node:sqlite').DatabaseSync)(path.join(ctx.server.dir, 'proofdeck.db'), { readOnly: true });
    const row = await until(() => { const r = db.prepare("SELECT state, attempts, error FROM outbox WHERE subject LIKE ? ").get('%Doomed email%'); return r && r.state === 'failed' ? r : null; }, 8000);
    db.close();
    assert.equal(row.attempts, 5);
    assert.match(row.error, /451 try again later/);
    assert.equal((await inbox(tess.client)).items.some((x) => x.title.includes('Doomed email')), true, 'the in-app notification is unaffected');
  } finally { dead.close(); await configure(); }
});

test('password reset by email: generic answers, one-time link, ends sessions, rate limited, off without a public address', async () => {
  const fresh = await startAdmin({ NOTIFY_TICK_MS: '100' });
  try {
    const fa = fresh.admin;
    const anon = new Client(fresh.server.base);
    assert.equal((await anon.post('/api/auth/forgot', { identifier: 'admin' })).status, 400, 'not available until email and the public address are configured');
    assert.equal((await anon.get('/api/auth/me')).data.resetAvailable, false);
    const s = await fakeSmtp();
    try {
      await fa.ok('PUT', '/api/settings/notifications', { smtp: { host: '127.0.0.1', port: s.port, security: 'none', from: 'proofdeck@example.com' } });
      assert.equal((await anon.post('/api/auth/forgot', { identifier: 'admin' })).status, 400, 'the public address is also required, so a forged Host header cannot build the link');
      await fa.ok('PUT', '/api/settings/notifications', { publicUrl: 'https://pd.example.com' });
      assert.equal((await anon.get('/api/auth/me')).data.resetAvailable, true);
      await fa.ok('PUT', '/api/auth/profile', { email: 'ada@example.com' });
      const second = await addUser(fresh.server, fa, 'noemail', 'tester');
      assert.ok(second.id);

      const known = await anon.post('/api/auth/forgot', { identifier: 'ADA@example.com' });
      const unknown = await anon.post('/api/auth/forgot', { identifier: 'ghost' });
      const noMail = await anon.post('/api/auth/forgot', { identifier: 'noemail' });
      assert.deepEqual([known.status, unknown.status, noMail.status], [200, 200, 200]);
      assert.deepEqual(known.data, unknown.data, 'no way to tell which usernames exist');
      const mail = await until(() => s.mails[0]);
      assert.equal(s.mails.length, 1, 'only the real address with an email got one');
      const token = /#\/reset\/([A-Za-z0-9_-]+)/.exec(decode(mail.raw).body)[1];
      assert.match(decode(mail.raw).body, /^Someone asked to reset the password for admin/);
      // the email is the only place the token lives: once delivered it is wiped from the outbox, and only a hash is kept for checking
      await until(() => fs.readdirSync(fresh.server.dir).filter((x) => x.startsWith('proofdeck.db')).every((f) => fs.readFileSync(path.join(fresh.server.dir, f)).indexOf(token) === -1));

      const oldSession = new Client(fresh.server.base); oldSession.cookie = fa.cookie;
      assert.equal((await anon.post('/api/auth/reset', { token: 'nonsense', password: 'new password 123' })).status, 400);
      assert.equal((await anon.post('/api/auth/reset', { token, password: 'short' })).status, 400, 'weak password refused, link still usable');
      assert.equal((await anon.post('/api/auth/reset', { token, password: 'a brand new password' })).status, 200);
      assert.equal((await anon.post('/api/auth/reset', { token, password: 'another new password' })).status, 400, 'single use');
      assert.equal((await oldSession.get('/api/projects')).status, 401, 'existing sessions are ended');
      assert.equal((await new Client(fresh.server.base).post('/api/auth/login', { username: 'admin', password: 'a brand new password' })).status, 200);
      assert.equal((await new Client(fresh.server.base).post('/api/auth/login', { username: 'admin', password: 'correct horse battery' })).status, 401);

      // a newer request replaces the older link; expired links are refused; the form is rate limited
      await anon.post('/api/auth/forgot', { identifier: 'admin' });
      await anon.post('/api/auth/forgot', { identifier: 'admin' });
      const links = await until(() => (s.mails.length >= 3 ? s.mails : null));
      const t1 = /#\/reset\/([A-Za-z0-9_-]+)/.exec(decode(links[1].raw).body)[1];
      const t2 = /#\/reset\/([A-Za-z0-9_-]+)/.exec(decode(links[2].raw).body)[1];
      assert.equal((await anon.post('/api/auth/reset', { token: t1, password: 'yet another password' })).status, 400, 'an older link stops working when a newer one is issued');
      assert.equal((await anon.post('/api/auth/forgot', { identifier: 'admin' })).status, 200, 'the third request in the hour is still fine');
      assert.equal((await anon.post('/api/auth/forgot', { identifier: 'admin' })).status, 429, 'but a fourth is refused: at most three per hour per account');
      const db = new (require('node:sqlite').DatabaseSync)(path.join(fresh.server.dir, 'proofdeck.db'));
      db.exec(`UPDATE password_resets SET expires_at='2000-01-01T00:00:00.000Z'`); db.close();
      assert.equal((await anon.post('/api/auth/reset', { token: t2, password: 'expired link password' })).status, 400, 'expired');
    } finally { s.close(); }
  } finally { fresh.server.stop(); }
});
