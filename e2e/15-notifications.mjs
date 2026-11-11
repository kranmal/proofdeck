// Notifications: account email prefs, email settings page, badge + list, email delivery, forgot/reset password.
import net from 'node:net';
import { connect } from './uilib.mjs';

// a tiny SMTP server that records messages
const mails = [];
const smtp = net.createServer((s) => {
  s.on('error', () => {}); let buf = '', data = null, rcpt = '';
  s.write('220 fake\r\n');
  s.on('data', (d) => {
    buf += d.toString();
    for (;;) {
      if (data !== null) { const e = buf.indexOf('\r\n.\r\n'); if (e < 0) return; mails.push({ to: rcpt, raw: buf.slice(0, e) }); buf = buf.slice(e + 5); data = null; s.write('250 ok\r\n'); continue; }
      const n = buf.indexOf('\r\n'); if (n < 0) return;
      const line = buf.slice(0, n); buf = buf.slice(n + 2);
      if (/^EHLO/i.test(line)) s.write('250 ok\r\n'); else if (/^MAIL/i.test(line)) s.write('250 ok\r\n');
      else if (/^RCPT/i.test(line)) { rcpt = /<(.*)>/.exec(line)[1]; s.write('250 ok\r\n'); }
      else if (/^DATA/i.test(line)) { data = ''; s.write('354 go\r\n'); } else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
    }
  });
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const body = (m) => Buffer.from(m.raw.split('\r\n\r\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8');
const waitMail = async (to, re, ms = 8000) => { const end = Date.now() + ms; for (;;) { const m = mails.find((x) => x.to === to && re.test(body(x) + x.raw)); if (m) return m; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 100)); } };

const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, field, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
const signOut = async () => { await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(700); };
const signIn = async (u, p) => { await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = ${JSON.stringify(u)}; f.password.value = ${JSON.stringify(p)}; f.requestSubmit(); })()`); await sleep(1300); };

// ---- account: email + frequency
await click('#me'); await sleep(300);
await field('email', 'ada@example.com'); await field('notify_email', 'instant'); await submit();
check('email and frequency are saved on the account', (await api('/api/auth/me')).user.email === 'ada@example.com');
check('notifications nav link is there', await visible('#nav a[data-nav=notifications]'));

// ---- admin: users with email
await go('#/users');
await click('[data-act=add]'); await sleep(300);
await field('username', 'tess'); await field('display_name', 'Tess Tester'); await field('email', 'tess@example.com'); await field('password', 'tess password 1'); await submit();
check('users list shows the email column', (await text('thead')).toLowerCase().includes('email') && (await text('tbody')).includes('tess@example.com'));

// ---- admin: email settings
await go('#/email-settings');
check('email page says not set up yet', (await text('.meta')).includes('Not set up'));
const set = (f, v) => setValue(`[data-f=${f}]`, v, f === 'security' || f === 'digestHour' ? 'change' : 'input');
await set('host', '127.0.0.1'); await set('port', String(smtp.address().port)); await set('security', 'none'); await set('from', 'proofdeck@example.com'); await set('publicUrl', 'https://pd.example.com');
await set('testTo', 'ada@example.com');
await click('[data-act=test]'); await sleep(1500);
check('test email is delivered and the page says so', (await text('#em-msg')).includes('Sent') && !!(await waitMail('ada@example.com', /If you can read it/)));
await set('host', '127.0.0.1'); await set('port', '1');
await click('[data-act=test]'); await sleep(1500);
check('a bad server shows the reason inline', (await text('#em-msg')).includes('Could not connect'), await text('#em-msg'));
await set('port', String(smtp.address().port));
await click('[data-act=save]'); await sleep(1000);
check('saving activates email and password reset', (await text('.meta')).includes('Active') && (await text('.card:nth-of-type(2)')).includes('is available on the sign-in screen'));
await shot('s15-email-settings');

// ---- a notification for tess
const bug = await api('/api/projects/1/bugs', 'POST', { title: 'Checkout total is wrong', actual: '£0' });
await api(`/api/bugs/${bug.id}`, 'PUT', { assignee_id: (await api('/api/users')).find((u) => u.username === 'tess').id });
const emailed = await waitMail('tess@example.com', /assigned .* to you: Checkout total is wrong/);
check('tess is emailed with a link', !!emailed && body(emailed).includes(`https://pd.example.com/#/bugs/${bug.id}`));
await signOut();
check('sign-in screen offers “Forgot your password?”', (await text('#auth')).includes('Forgot your password?'));
await signIn('tess', 'tess password 1');
check('the badge shows 1 unread', (await text('#nav a[data-nav=notifications] .badge')) === '1');
await go('#/notifications');
check('the list shows it as unread with the title', (await count('li.unread')) === 1 && (await text('.notifs')).includes('assigned') && (await text('.notifs')).includes('Checkout total is wrong'));
await shot('s15-notifications');
await js(`document.querySelector('li.unread a').click()`); await sleep(900);
check('clicking opens the bug', (await js('location.hash')) === `#/bugs/${bug.id}`);
await sleep(500);
check('and clears the badge', !(await exists('#nav a[data-nav=notifications] .badge')));
await go('#/notifications');
check('it is now read; mark-all is gone', (await count('li.unread')) === 0 && !(await exists('[data-act=all]')) && (await text('.meta')).includes('all caught up'));
check('tess sees no admin pages', !(await visible('#nav a[data-nav=email-settings]')));

// ---- forgot / reset password
await signOut();
await click('#forgot'); await sleep(300);
await js(`(() => { const f = document.querySelector('#auth-form'); f.identifier.value = 'tess'; f.requestSubmit(); })()`); await sleep(1200);
check('the answer is generic', (await text('#auth')).includes('If an account matches'));
const resetMail = await waitMail('tess@example.com', /#\/reset\//);
check('reset email arrives with a one-hour link', !!resetMail && /within 60 minutes/.test(body(resetMail)));
const token = /#\/reset\/([A-Za-z0-9_-]+)/.exec(body(resetMail))[1];
await t.open(`/#/reset/${token}`); await sleep(500);
check('the link opens the new-password form and the token leaves the address bar', (await text('#auth h1')) === 'Choose a new password' && !(await js('location.href')).includes(token));
await js(`(() => { const f = document.querySelector('#auth-form'); f.password.value = 'a new tess password'; f.again.value = 'different one'; f.requestSubmit(); })()`); await sleep(500);
check('mismatched passwords are refused', (await text('#auth-err')).includes('differ'));
await js(`(() => { const f = document.querySelector('#auth-form'); f.again.value = 'a new tess password'; f.requestSubmit(); })()`); await sleep(1200);
check('success returns to sign-in with a message', (await text('#auth h1')) === 'Sign in' && (await text('#auth-err')).includes('Password changed'));
await signIn('tess', 'a new tess password');
check('the new password works', await visible('#me') && (await text('#me')).includes('Tess Tester'));
await signOut();
await t.open(`/#/reset/${token}`); await sleep(500);
await js(`(() => { const f = document.querySelector('#auth-form'); f.password.value = 'another password'; f.again.value = 'another password'; f.requestSubmit(); })()`); await sleep(1000);
check('the link only works once', (await text('#auth-err')).includes('invalid or has expired'));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|502)/.test(e)).length === 0, t.errors.join(' | '));
smtp.close();
process.exit(t.finish() ? 1 : 0);
