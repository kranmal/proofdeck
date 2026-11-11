// Stage 4 UI: version history, compare, restore, and the "changed since this run" note.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

// Case 2 gets two edits; a run is started after the first one.
await api('/api/cases/2', 'PUT', { title: 'Add item to cart (edited)', steps: [{ action: 'Open any product page', test_data: 'Blue mug', expected: 'Product page shown' }, { action: 'Press "Add to cart"', expected: 'Badge shows 1' }, { action: 'Open the cart', expected: 'Cart lists the product' }, { action: 'Check out', expected: 'Order placed' }] });
const run = await api('/api/cases/2/run', 'POST', {});
await api('/api/cases/2', 'PUT', { priority: 'Low', precondition: 'Cart is empty and user is signed in', steps: [{ action: 'Open any product page', test_data: 'Red mug', expected: 'Product page shown' }, { action: 'Press "Add to cart"', expected: 'Badge shows 1' }] });

await go('#/cases/2');
check('editor shows the version and who edited it', (await text('.meta')).includes('Version 3') && (await text('.meta')).includes('last edited by Ada Admin'), await text('.meta'));
check('history lists 3 versions, newest first, current marked', (await count('.card table tbody tr')) >= 3 && (await text('[data-act=compare]')) !== null);
const rows = await js(`[...document.querySelectorAll('h2')].find(h => h.textContent === 'Version history').closest('section').querySelectorAll('tbody tr').length`);
check('three rows in the history table', rows === 3, String(rows));
check('current version has no compare/restore buttons', (await count('[data-act=compare]')) === 2 && (await count('[data-act=restore]')) === 2);
check('current version is labelled', (await text('.pill.active')) === 'Current');

// compare v1 with current (v3)
await js(`document.querySelector('[data-act=compare][data-v="1"]').click()`); await sleep(700);
const diff = await text('#dlg');
check('diff dialog names the versions', diff.includes('Version 1 compared with the current version (v3)'));
check('diff lists changed fields in words', diff.includes('Title') && diff.includes('Priority') && diff.includes('Preconditions') && diff.includes('Changed'));
check('diff shows old and new values', diff.includes('Add item to cart') && diff.includes('Low') && diff.includes('Cart is empty and user is signed in'));
check('diff reports a removed step with a text label', diff.includes('Step 3') && diff.includes('Removed since'), diff.replace(/\n/g, ' ').slice(0, 300));
check('changed step 1 data shows both values', diff.includes('Blue mug') && diff.includes('Red mug'));
check('old column is visually struck through', await js(`getComputedStyle(document.querySelector('#dlg .was .pre')).textDecorationLine.includes('line-through')`));
await shot('s4-diff');
await js(`document.querySelector('#dlg [data-close]').click()`); await sleep(300);
await js(`document.querySelector('[data-act=compare][data-v="2"]').click()`); await sleep(600);
check('v2 vs v3 has a removed step 3 and 4', (await text('#dlg')).includes('Step 4') && (await text('#dlg')).includes('Removed since'));
await js(`document.querySelector('#dlg [data-close]').click()`); await sleep(300);

// restore v1
await js(`window.confirm = () => true`);
await js(`document.querySelector('[data-act=restore][data-v="1"]').click()`); await sleep(1100);
check('restore creates v4 with a note', (await text('.meta')).includes('Version 4') && (await text('#view')).includes('Restored from v1'));
check('editor now shows the restored content', (await js(`document.querySelector('#f-title').value`)) === 'Add item to cart' && (await js(`document.querySelector('#f-priority').value`)) === 'High');
check('restored steps are back', (await count('#steps .steprow')) === 3);
const api4 = await api('/api/cases/2/versions');
check('history keeps every version', api4.length === 4 && api4[0].note === 'Restored from v1');
await shot('s4-history');

// player: the run started at v2
await go(`#/run/${run.executionId}`);
check('player shows the case version used', (await text('.meta')).includes('Test case v2'), await text('.meta'));
check('player warns the case changed since', (await text('.meta')).includes('has changed since this run (now v4)'));
check('warning links to the case', await js(`!!document.querySelector('.meta a[href="#/cases/2"]')`));
check('the run kept its original title', (await text('.head h1')).includes('Add item to cart (edited)'));

// saving through the UI without changes does not create a version
await go('#/cases/2');
await click('[data-act=save]'); await sleep(900);
check('saving untouched content creates no version', (await api('/api/cases/2/versions')).length === 4);

// viewer cannot restore
await api('/api/users', 'POST', { username: 'vic', password: 'vic password 12', role: 'viewer' });
await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(600);
await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = 'vic'; f.password.value = 'vic password 12'; f.requestSubmit(); })()`); await sleep(1200);
await go('#/cases/2');
check('viewer sees history but not Restore', (await count('[data-act=compare]')) === 3 && !(await visible('[data-act=restore]')));

const unexpected = t.errors.filter((e) => !/status of (401|403|400)/.test(e));
check('no console errors', unexpected.length === 0, unexpected.join(' | '));
process.exit(t.finish() ? 1 : 0);
