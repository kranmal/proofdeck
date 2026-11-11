// Stage 1 UI: setup, sign in/out, users admin, assignees, comments, viewer lockout, ended session.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, submit, field, shot } = t;

await t.open('/');
check('fresh install shows the create-admin screen', (await text('#auth h1')) === 'Create the admin account' && await visible('#auth'));
check('app chrome is hidden behind it', !(await visible('#me')));
await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = 'admin'; f.display_name.value = 'Ada Admin'; f.password.value = 'short'; f.requestSubmit(); })()`); await sleep(700);
check('weak password is refused with a message', (await text('#auth-err')).includes('at least 8'), await text('#auth-err'));
await shot('s1-setup');
await js(`(() => { const f = document.querySelector('#auth-form'); f.password.value = 'correct horse battery'; f.requestSubmit(); })()`); await sleep(1200);
check('setup signs in and shows the app', !(await visible('#auth')) && await visible('#me') && (await text('#me')).includes('Ada Admin'));
check('admin sees Users in the nav', await visible('#nav a[data-nav=users]'));
check('overview shows 6 tiles incl. assigned-to-you', (await count('.tile')) === 6);

// sign out via account menu
await click('#me'); await sleep(400);
check('account dialog opens', await js(`document.querySelector('#dlg').open`) && (await text('#dlg h2')) === 'Account');
await js(`document.querySelector('[data-signout]').click()`); await sleep(800);
check('sign out returns to the sign-in screen', (await text('#auth h1')) === 'Sign in');
await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = 'admin'; f.password.value = 'wrong wrong wrong'; f.requestSubmit(); })()`); await sleep(900);
check('wrong password shows a generic error', (await text('#auth-err')) === 'Wrong username or password');
await js(`(() => { const f = document.querySelector('#auth-form'); f.password.value = 'correct horse battery'; f.requestSubmit(); })()`); await sleep(1200);
check('right password gets back in', !(await visible('#auth')) && (await count('.tile')) === 6);

// users admin
await go('#/users');
check('users page lists the admin', (await count('tbody tr')) === 1);
await click('[data-act=add]'); await sleep(300);
await field('username', 'tess'); await field('display_name', 'Tess Tester'); await field('password', 'tess password 1');
await submit();
await click('[data-act=add]'); await sleep(300);
await field('username', 'vic'); await field('display_name', 'Vic Viewer'); await field('role', 'viewer'); await field('password', 'vic password 12');
await submit();
check('two users added', (await count('tbody tr')) === 3);
check('roles shown as pills', (await text('tbody')).includes('viewer') && (await text('tbody')).includes('tester'));
await shot('s1-users');
await js(`document.querySelector('[data-act=edit][data-id="2"]').click()`); await sleep(300);
await field('display_name', 'Tess T.'); await submit();
check('edit saves the name', (await text('tbody')).includes('Tess T.'));

// assignees on the cycle page
await go('#/cycles/1');
const opts = await js(`[...document.querySelector('[data-assign]').options].map(o => o.textContent.trim())`);
check('assignee picker lists active users', JSON.stringify(opts) === JSON.stringify(['Unassigned', 'Ada Admin', 'Tess T.', 'Vic Viewer']), JSON.stringify(opts));
await js(`(() => { const s = document.querySelector('[data-assign]'); s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(600);
check('assigning saves', (await api('/api/cycles/1')).executions[0].assignee_name === 'Tess T.');
await go('#/run/1');
check('player shows the assignee', (await text('.meta')).includes('Assigned to Tess T.'));

// bug: assignee + comments
const sr = (await api('/api/executions/1')).steps[0].id;
await api(`/api/step-results/${sr}`, 'PUT', { status: 'Fail', actual: 'it broke' });
const bug = await api(`/api/step-results/${sr}/bug`, 'POST', {});
await go(`#/bugs/${bug.id}`);
check('bug shows who reported it', (await text('.meta')).includes('by Ada Admin'));
await js(`(() => { const s = document.querySelector('#b-assignee_id'); s.value = '2'; })()`);
await click('[data-act=save]'); await sleep(800);
check('bug assignee saved', (await api(`/api/bugs/${bug.id}`)).assignee_name === 'Tess T.');
await setValue('#b-new-comment', 'Reproduced on staging');
await click('[data-act=comment]'); await sleep(900);
check('comment appears with author', (await text('.comment')).includes('Ada Admin') && (await text('.comment')).includes('Reproduced on staging'));
check('draft textarea cleared', (await js(`document.querySelector('#b-new-comment').value`)) === '');
await shot('s1-bug');
await go('#/bugs');
await setValue('#bwho', 'me', 'change'); await sleep(200);
check('"Assigned to me" hides a bug assigned to someone else', (await count('#rows tr[data-id], #rows tr')) === 1 && (await text('#rows')).includes('No bugs here'));
await setValue('#bwho', '', 'change'); await sleep(200);
check('"Anyone" shows it with the assignee name', (await text('#rows')).includes('Tess T.'));

// viewer
await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(700);
await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = 'vic'; f.password.value = 'vic password 12'; f.requestSubmit(); })()`); await sleep(1200);
check('viewer is marked read-only', (await text('#me')).includes('read-only') && await js(`document.body.classList.contains('viewer')`));
check('viewer does not see Users', !(await visible('#nav a[data-nav=users]')));
await go('#/cases');
check('viewer has no New test case / Import buttons', !(await visible('a[href="#/cases/new"]')) && !(await visible('[data-act=import]')));
const forbidden = await api('/api/projects', 'POST', { name: 'Nope', key: 'NOPE' });
check('server refuses viewer writes', forbidden.error === 'Your account is read-only', JSON.stringify(forbidden));
await go('#/users');
check('viewer cannot open the users page', (await text('#view')).includes('Only admins'));

// session ended while the page is open
const adminCookie = await t.nodeLogin('admin', 'correct horse battery');
const users = await (await fetch(t.app + '/api/users', { headers: { Cookie: adminCookie } })).json();
const vicId = users.find((u) => u.username === 'vic').id;
await fetch(t.app + `/api/users/${vicId}`, { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
await go('#/cycles'); await sleep(400);
check('deactivated user is kicked to sign-in with a reason', (await text('#auth h1')) === 'Sign in' && (await text('#auth-err')).includes('session has ended'));

const unexpected = t.errors.filter((e) => !/status of (401|403|400)/.test(e));
check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
process.exit(t.finish() ? 1 : 0);
