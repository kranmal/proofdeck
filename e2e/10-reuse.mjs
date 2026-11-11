// Stage 6 UI: call-to-test steps and data sets in the editor, cycle, player, bug repro text and version diff.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, field, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

const login = await api('/api/projects/1/cases', 'POST', { title: 'Log in', steps: [{ action: 'Open /login', expected: 'Form shown' }, { action: 'Submit credentials', expected: 'Dashboard' }] });
const buy = await api('/api/projects/1/cases', 'POST', { title: 'Buy a mug', steps: [{ action: 'Search for {{item}}', expected: '{{item}} is listed' }] });

await go(`#/cases/${buy.id}`);
// ---- call step
await click('[data-act=add-call]'); await sleep(300);
check('call row appears with a case picker', await exists('.steprow.call select') && (await count('.steprow.call select option')) >= 3);
await click('[data-act=save]'); await sleep(600);
check('saving with an empty call step is refused with a clear message', (await text('#toast')).includes('Choose which test case'), await text('#toast'));
await js(`(() => { const s = document.querySelector('.steprow.call select'); s.value = '${login.id}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await js(`(() => { const rows = [...document.querySelectorAll('#steps .steprow')]; })()`);
// move the call to the top with the up arrow
await js(`document.querySelector('.steprow.call [data-act=up]').click()`); await sleep(200);
check('call step can be reordered', await js(`document.querySelector('#steps .steprow').classList.contains('call')`));

// ---- data sets
await click('[data-act=add-col]'); await click('[data-act=add-col]'); await sleep(200);
check('two columns and one blank row appear', (await count('[data-col]')) === 2 && (await count('[data-cell]')) === 2);
await setValue('[data-col="0"]', 'item'); await setValue('[data-col="1"]', 'qty');
await setValue('[data-cell="0:0"]', 'blue mug'); await setValue('[data-cell="0:1"]', '1');
await click('[data-act=add-row]'); await sleep(150);
await setValue('[data-cell="1:0"]', 'red mug'); await setValue('[data-cell="1:1"]', '2');
check('row count hint shows runs', (await text('#params')).includes('2 rows = 2 runs'));
await shot('s6-editor');
await click('[data-act=save]'); await sleep(1000);
const saved = await api(`/api/cases/${buy.id}`);
check('saved: call step first, data set stored', saved.steps[0].call_case_id === login.id && saved.params.columns.join() === 'item,qty' && saved.params.rows.length === 2, JSON.stringify([saved.steps.map((s) => s.call_case_id), saved.params]));
await go(`#/cases/${buy.id}`);
check('reload shows the call with its target and the data', (await js(`document.querySelector('.steprow.call select').value`)) === String(login.id) && (await js(`document.querySelector('[data-cell="1:0"]').value`)) === 'red mug');
await go(`#/cases/${login.id}`);
check('called case shows who uses it', (await text('#view')).includes('Used by') && (await text('#view')).includes('Buy a mug'));

// ---- paste data
await go(`#/cases/${buy.id}`);
await click('[data-act=paste-data]'); await sleep(300);
await field('data', 'item\tqty\nblue mug\t1\nred mug\t2\ngreen mug\t3'); await submit();
check('pasting spreadsheet data replaces the grid', (await count('[data-cell]')) === 6 && (await js(`document.querySelector('[data-cell="2:0"]').value`)) === 'green mug');
await click('[data-act=del-row][data-i="1"]'); await sleep(200);
check('rows can be removed', (await count('[data-cell]')) === 4 && (await js(`document.querySelector('[data-cell="1:0"]').value`)) === 'green mug');
await click('[data-act=save]'); await sleep(900);
check('three-row then two-row set saved', (await api(`/api/cases/${buy.id}`)).params.rows.length === 2);

// ---- cycle with data iterations
const cyc = await api('/api/projects/1/cycles', 'POST', { name: 'Data cycle', caseIds: [buy.id] });
await go(`#/cycles/${cyc.id}`);
check('cycle lists one row per data set with its values', (await count('tbody tr')) === 2 && (await text('tbody')).includes('data set 1: item=blue mug; qty=1') && (await text('tbody')).includes('data set 2: item=green mug; qty=3'), (await text('tbody')).replace(/\n/g, ' ').slice(0, 200));
await js(`document.querySelector('tbody tr a').click()`); await sleep(800);
check('player shows the data set and substituted steps', (await text('.meta')).includes('Data set 1: item=blue mug; qty=1') && (await text('.step:last-of-type')).includes('Search for blue mug'));
check('steps pulled from the called case carry a chip', (await count('.step .chip.ext')) === 2 && (await text('.step .chip.ext')).includes(`from ${login.key}`), (await text('.step')).slice(0, 120));
check('own step has no chip and is substituted', (await text('.step:last-of-type')).includes('Search for blue mug') && (await text('.step:last-of-type')).includes('blue mug is listed'));
// fail the last step -> bug dialog repro text
await js(`document.querySelector('.step:last-of-type [data-v=Fail]').click()`); await sleep(700);
await js(`document.querySelector('.step:last-of-type [data-act=bug]').click()`); await sleep(900);
const repro = await js(`document.querySelector('#dlg form').elements.steps_to_reproduce.value`);
check('bug repro text names the data set and where each step came from', repro.startsWith('Data set: item=blue mug; qty=1') && repro.includes(`1. [${login.key}] Open /login`) && repro.includes('3. Search for blue mug'), repro.replace(/\n/g, ' | '));
await shot('s6-bugdialog');
await js(`document.querySelector('#dlg [data-close]').click()`); await sleep(300);
check('next data set is one click away', await exists('a[href^="#/run/"]'));

// ---- standalone run from the list
await go('#/cases');
await js(`[...document.querySelectorAll('#rows tr')].find(r => r.innerText.includes('Buy a mug')).querySelector('[data-act=run]').click()`); await sleep(1000);
check('standalone run opens the first data set with a position', (await text('.head')).includes('Standalone run · 1 of 2') && (await text('.head')).includes('Next'));
await js(`[...document.querySelectorAll('.head a')].find(a => a.textContent.includes('Next')).click()`); await sleep(700);
check('next moves to data set 2', (await text('.meta')).includes('Data set 2: item=green mug; qty=3') && (await text('.head')).includes('2 of 2'));

// ---- compare dialog mentions calls and data sets
await go(`#/cases/${buy.id}`);
await js(`document.querySelector('[data-act=compare][data-v="1"]').click()`); await sleep(800);
const diff = await text('#dlg');
check('diff shows data sets changed and the added call step', diff.includes('Data sets') && diff.includes('item, qty') && diff.includes(`Calls test case ${login.key}`), diff.replace(/\n/g, ' ').slice(0, 260));
await js(`document.querySelector('#dlg [data-close]').click()`); await sleep(200);

// ---- loop is refused in the UI too
await go(`#/cases/${login.id}`);
await click('[data-act=add-call]'); await sleep(200);
await js(`(() => { const s = document.querySelector('.steprow.call select'); s.value = '${buy.id}'; })()`);
await click('[data-act=save]'); await sleep(700);
check('a call loop is refused with a message', (await text('#toast')).includes('cannot call itself'), await text('#toast'));
await shot('s6-loop');

const unexpected = t.errors.filter((e) => !/status of (401|403|400)/.test(e));
check('no console errors', unexpected.length === 0, unexpected.join(' | '));
process.exit(t.finish() ? 1 : 0);
