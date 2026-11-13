// Saved views on the bugs, test cases and cycles lists.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, setValue, submit, field, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
await js(`window.confirm = () => true`);
for (const title of ['Alpha', 'Beta']) await api('/api/projects/1/bugs', 'POST', { title, actual: 'x' });
const bugs = await api('/api/projects/1/bugs');
await api(`/api/bugs/${bugs.find((b) => b.title === 'Beta').id}`, 'PUT', { status: 'Resolved' });

// ---- bugs
await go('#/bugs'); await sleep(600);
check('views drop-down is on the bugs list', (await count('#viewsbar [data-v-pick]')) === 1);
await setValue('#bstatus', 'Resolved', 'change'); await sleep(300);
check('filter shows only resolved bugs', (await text('#rows')).includes('Beta') && !(await text('#rows')).includes('Alpha'));
await click('[data-v-save]'); await sleep(300);
await field('name', 'Resolved ones'); await js(`document.querySelector('dialog input[name=shared]').click()`); await submit(); await sleep(800);
check('the saved view appears selected and marked shared', (await text('#viewsbar')).includes('Resolved ones (shared)'), await text('#viewsbar'));
await setValue('#bstatus', 'all', 'change'); await sleep(300);
check('changing the filter shows everything', (await text('#rows')).includes('Alpha'));
await setValue('#viewsbar [data-v-pick]', String((await api('/api/projects/1/views?scope=bugs'))[0].id), 'change'); await sleep(900);
check('picking the view restores the filter', (await js(`document.querySelector('#bstatus').value`)) === 'Resolved' && !(await text('#rows')).includes('Alpha'));

// ---- cases
await go('#/cases'); await sleep(700);
await setValue('#status-filter', 'Approved', 'change'); await sleep(300);
await js(`(() => { const q = document.querySelector('#q'); q.value = 'cart'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(300);
await click('[data-v-save]'); await sleep(300);
await field('name', 'Approved carts'); await submit(); await sleep(800);
await go('#/bugs'); await sleep(300); await go('#/cases'); await sleep(500);
await js(`(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await setValue('#status-filter', '', 'change'); await sleep(300);
const v = (await api('/api/projects/1/views?scope=cases'))[0];
await setValue('#viewsbar [data-v-pick]', String(v.id), 'change'); await sleep(900);
check('a saved test case view restores search and status', (await js(`document.querySelector('#q').value`)) === 'cart' && (await js(`document.querySelector('#status-filter').value`)) === 'Approved');

// ---- delete
await click('[data-v-del]'); await sleep(700);
check('a view can be deleted', (await api('/api/projects/1/views?scope=cases')).length === 0);
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
