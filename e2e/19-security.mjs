// Activity page (changes + sign-ins), sessions in the account dialog, user sign-out, token expiry and scope.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, field, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
await js('window.confirm = () => true');
const APP = 'http://127.0.0.1:4791';
const signOut = async () => { await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(700); };
const signIn = async (u, p) => { await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = ${JSON.stringify(u)}; f.password.value = ${JSON.stringify(p)}; f.requestSubmit(); })()`); await sleep(1300); };
await api('/api/users', 'POST', { username: 'tess', display_name: 'Tess Tester', password: 'tess password 1', role: 'tester' });

// ---- activity page
check('admin sees Activity in the nav', await visible('#nav a[data-nav=audit]'));
await go('#/audit');
check('the Changes tab lists the user that was just created, with who did it', (await text('#auditbody')).includes('User created') && (await text('#auditbody')).includes('Ada Admin') && (await text('#auditbody')).includes('username: tess'));
await setValue('#asearch', 'zzz-no-such-thing', 'input'); await sleep(700);
check('searching narrows it, and an empty result says so', (await text('#auditbody')).includes('Nothing matches that search'));
await setValue('#asearch', 'tess', 'input'); await sleep(700);
check('searching again finds it', (await text('#auditbody')).includes('User created'));
await shot('s19-activity');

// ---- failed and successful sign-ins show up
await signOut();
await signIn('tess', 'not the password');
check('a wrong password still shows the generic error', (await text('#auth-err')) === 'Wrong username or password');
await signIn('admin', 'correct horse battery');
await go('#/audit'); await click('[data-tab=signins]'); await sleep(500);
check('the Sign-ins tab shows the failed attempt with the reason', (await text('#auditbody')).includes('Failed') && (await text('#auditbody')).includes('wrong password') && (await text('#auditbody')).includes('tess'));
await click('#afails'); await sleep(600);
check('the failed-only filter hides successes', !(await text('#auditbody')).includes('Signed in'));

// ---- sessions in the account dialog
const other = await (await fetch(`${APP}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Firefox/120.0' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) })).status;
check('a second device can sign in', other === 200);
await click('#me'); await sleep(900);
check('the account dialog lists this device and the other one', (await text('#sessions')).includes('This device') && (await text('#sessions')).includes('Firefox on Windows'), await text('#sessions'));
await click('[data-kill]'); await sleep(900);
check('signing out the other device removes it from the list', !(await text('#sessions')).includes('Firefox on Windows') && (await text('#sessions')).includes('This device'));
await js(`document.querySelector('#history').open = true`); await sleep(700);
check('recent sign-in attempts are listed', (await text('#hist')).includes('Signed in'));
await js(`document.querySelector('#dlg [data-close]').click()`); await sleep(300);

// ---- admin signs a user out everywhere
const tessSession = await fetch(`${APP}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tess', password: 'tess password 1' }) });
const cookie = tessSession.headers.getSetCookie()[0].split(';')[0];
await go('#/users');
await js(`[...document.querySelectorAll('tr')].find((r) => r.textContent.includes('tess')).querySelector('[data-act=signout]').click()`); await sleep(900);
check('their session is gone', (await (await fetch(`${APP}/api/auth/me`, { headers: { Cookie: cookie } })).json()).user === null);

// ---- token expiry and scope
await go('#/api-tokens'); await click('[data-act=new]'); await sleep(500);
await field('name', 'Gate bot'); await field('scope', 'read'); await field('expires_in_days', '30'); await submit(); await sleep(900);
await js(`document.querySelector('#dlg [type=submit]').click()`); await sleep(700);
check('the token list shows its access and expiry', (await text('#view table')).includes('Gate bot') && (await text('#view table')).includes('Read only') && (await text('#view table')).includes('until'), await text('#view table'));
await go('#/audit');
check('creating the token was recorded', (await text('#auditbody')).includes('API token created'));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|502)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
