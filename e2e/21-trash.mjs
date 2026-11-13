// Trash: delete shows an Undo toast, the Trash page restores and purges.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
await js(`window.confirm = () => true`);

// ---- delete a bug: undo from the toast
await api('/api/projects/1/bugs', 'POST', { title: 'Undo me', actual: 'x' });
const bug = (await api('/api/projects/1/bugs')).find((b) => b.title === 'Undo me');
await go(`#/bugs/${bug.id}`); await sleep(500);
await js(`window.confirm = () => true`);
await click('[data-act=delete]'); await sleep(900);
check('deleting a bug lands on the list and shows an Undo toast', location_ok(await js('location.hash'), '#/bugs') && (await text('#toast')).includes('moved to Trash') && await visible('#toast [data-undo]'), await text('#toast'));
await click('#toast [data-undo]'); await sleep(1000);
check('Undo restores the bug and opens it', (await js('location.hash')).startsWith('#/bugs/') && (await js(`document.querySelector('#b-title')?.value`)) === 'Undo me', await js('location.hash'));
check('the trash is empty again', (await api(`/api/projects/1/trash`)).items.length === 0);

// ---- delete a case, restore from the Trash page
await go('#/cases/3'); await sleep(500);
await js(`window.confirm = () => true`);
await click('[data-act=delete]'); await sleep(900);
check('the case is gone', (await api('/api/projects/1/cases')).every((c) => c.id !== 3));
check('Trash link is in the nav', await visible('#nav a[data-nav=trash]'));
await go('#/trash'); await sleep(500);
check('the Trash page lists it with who deleted it', (await count('#view tbody tr')) === 1 && (await text('#view tbody')).includes('Apply discount'), await text('#view'));
await shot('trash-page');
await click('[data-act=restore]'); await sleep(900);
check('restore brings it back and the page shows it empty', (await api('/api/projects/1/cases')).some((c) => c.id === 3) && (await text('#view')).includes('Trash is empty'));

// ---- purge for good
await api('/api/projects/1/bugs', 'POST', { title: 'Gone for good', actual: 'x' });
const b2 = (await api('/api/projects/1/bugs')).find((b) => b.title === 'Gone for good');
await api(`/api/bugs/${b2.id}`, 'DELETE');
await go('#/bugs'); await sleep(300);
await go('#/trash'); await sleep(500);
await js(`window.confirm = () => true`);
await click('[data-act=purge]'); await sleep(800);
check('purge removes it for good', (await api('/api/projects/1/trash')).items.length === 0);
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
function location_ok(h, want) { return h === want; }
