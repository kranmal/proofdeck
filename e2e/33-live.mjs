// Live updates: another account changes things while this browser stays on the page.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
await api('/api/users', 'POST', { username: 'zed', display_name: 'Zed Other', role: 'tester', password: 'zed-password-123' });

// a second person, over plain HTTP
let cookie = '';
const login = await fetch('http://127.0.0.1:4791/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'zed', password: 'zed-password-123' }) });
cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const other = async (path, method = 'GET', body) => (await fetch('http://127.0.0.1:4791' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined })).json();
const me = (await api('/api/auth/me')).user;

// 1. a list the person is only reading updates by itself
await go('#/bugs'); await sleep(900);
await other('/api/projects/1/bugs', 'POST', { title: 'Filed by Zed', actual: 'x' });
await sleep(2200);
check('a bug filed by someone else appears without reloading', (await text('#view')).includes('Filed by Zed'), (await text('#view')).slice(0, 200));
check('no refresh notice was needed', (await count('#livebar')) === 0);

// 2. while a field has focus the page is left alone and a notice is shown instead
await js(`(document.querySelector('#view input[type=search], #view input[type=text], #view input:not([type]), #view select') || {}).focus && (document.querySelector('#view input[type=search], #view input[type=text], #view input:not([type]), #view select')).focus()`);
check('a field is focused', await js(`/^(INPUT|SELECT)$/.test(document.activeElement.tagName)`));
await other('/api/projects/1/bugs', 'POST', { title: 'Second from Zed', actual: 'x' });
await sleep(2200);
check('the page did not change under the person', !(await text('#view')).includes('Second from Zed'));
check('a refresh notice appears', (await count('#livebar')) === 1, await text('#view'));
await click('#livebar button'); await sleep(900);
check('Refresh shows the new bug and removes the notice', (await text('#view')).includes('Second from Zed') && (await count('#livebar')) === 0);

// 3. an editor is never replaced, only flagged
await go('#/cases/1'); await sleep(900);
await other('/api/cases/1', 'PUT', { title: 'Renamed by Zed' });
await sleep(2200);
check('the case editor shows a notice and keeps its content', (await count('#livebar')) === 1 && !(await js(`document.querySelector('#view [name=title], #view #title') ? document.querySelector('#view [name=title], #view #title').value : ''`)).includes('Renamed by Zed'));
await go('#/bugs'); await sleep(600);
check('the notice goes away when moving to another page', (await count('#livebar')) === 0);

// 4. my own changes are not echoed back as notices
await api('/api/projects/1/bugs', 'POST', { title: 'Mine', actual: 'x' });
await sleep(1500);
check('no notice for my own change', (await count('#livebar')) === 0);

// 5. a mention shows up in the bell at once (the slow poll runs every two minutes)
const bug = (await api('/api/projects/1/bugs'))[0];
await other(`/api/bugs/${bug.id}/comments`, 'POST', { body: 'ping @admin' });
await sleep(1500);
check('the unread badge appears without waiting', (await text('#nav a[data-nav=notifications] .badge')).trim() === '1', await text('#nav'));

check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404|429)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
