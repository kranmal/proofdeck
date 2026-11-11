// CI results: API token page (create once, revoke), results appear in the app, executor label, viewer lockout.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, field, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

await go('#/api-tokens');
check('nav link and empty state', await visible('#nav a[data-nav=api-tokens]') && (await text('#view')).includes('No tokens yet'));
const origin = await js('location.origin');
check('snippets use this server’s address and have copy buttons', (await text('#snip0')).includes(`${origin}/api/ci/junit`) && (await count('[data-copy]')) === 4);
await click('[data-act=new]'); await sleep(300);
await field('name', 'GitHub Actions'); await submit(); await sleep(500);
check('the token is shown once, in a dialog', await js(`document.querySelector('#dlg').open`) && /^pd_[A-Za-z0-9_-]{40}$/.test(await js(`document.querySelector('#tok').value`)));
const token = await js(`document.querySelector('#tok').value`);
await shot('s13-token');
await submit(); await sleep(600);
check('afterwards only a fingerprint is listed, never the token', (await text('tbody')).includes(token.slice(0, 8) + '…') && !(await js(`document.body.innerText`)).includes(token));
check('status is Active and last used is Never', (await text('tbody')).includes('Active') && (await text('tbody')).includes('Never'));

// CI posts results with the token (from outside the browser)
const post = (body) => fetch(`${t.app}/api/ci/results`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const res = await post({ cycle: { name: 'Nightly', build: '1.4.2', environment: 'CI' }, createBugs: true, results: [
  { case: 'DEMO-T1', status: 'Pass' }, { case: 'DEMO-T2', status: 'Fail', message: 'Badge not updated' }, { automation_key: 'unknown::test', status: 'Pass' }] });
check('API accepted the results (2 recorded, 1 reported as an error)', res.summary.recorded === 2 && res.summary.errors === 1 && res.summary.bugs_created === 1, JSON.stringify(res.summary));

await go(`#/cycles/${res.cycle.id}`);
check('the cycle shows the results and who ran them', (await text('tbody')).includes('API: GitHub Actions') && (await text('tbody')).includes('Fail') && (await text('tbody')).includes('Pass'));
await js(`[...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('DEMO-T2')).querySelector('a').click()`); await sleep(800);
check('the player shows the CI message and who ran it', (await text('.meta')).includes('Last run by API: GitHub Actions') && (await js(`document.querySelector('#comment').value`)).includes('Badge not updated'));
await go('#/bugs');
check('the automatic bug is listed and marked as from CI', (await text('#rows')).includes('[CI] DEMO-T2: Badge not updated'));

await go('#/api-tokens');
check('last used is now filled in', !(await text('tbody')).includes('Never'));
await js(`window.confirm = () => true`);
await click('[data-act=revoke]'); await sleep(800);
check('revoked token is marked and cannot be revoked again', (await text('tbody')).includes('Revoked') && !(await exists('[data-act=revoke]')));
const after = await fetch(`${t.app}/api/ci/cycle?id=${res.cycle.id}`, { headers: { Authorization: `Bearer ${token}` } });
check('a revoked token stops working at once', after.status === 401);

// a viewer cannot open the page
await api('/api/users', 'POST', { username: 'vic', password: 'vic password 12', role: 'viewer' });
await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(600);
await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = 'vic'; f.password.value = 'vic password 12'; f.requestSubmit(); })()`); await sleep(1200);
check('viewers do not see the page or its API', !(await visible('#nav a[data-nav=api-tokens]')) && (await api('/api/projects/1/api-tokens')).error === 'Only admins can do this');
check('no console errors', t.errors.filter((e) => !/status of (401|403|400)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
