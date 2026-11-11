// Import dialog: update-existing mode, HTML detection and stripping, requirement links from "Coverage (Issues)".
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

const csv = [
  'Key,Name,Status,Folder,Priority,Coverage (Issues),Test Script (Step-by-Step) - Step,Test Script (Step-by-Step) - Expected Result',
  'DEMO-T1,Sign in (renamed by file),Approved,/Authentication,High,"PROJ-1, PROJ-2",<p>Open the <strong>login</strong> page</p>,<p>Form is shown<br/>with fields</p>',
  'NEW-T7,A brand new case,Draft,/Imports,Normal,,Do it,Done',
].join('\r\n');
const pick = (name, content) => js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: 'text/csv' }));
  const inp = document.querySelector('#dlg input[type=file]'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`);

await go('#/cases');
await click('[data-act=import]'); await sleep(300);
await pick('zephyr.csv', csv); await sleep(1200);
check('columns recognised, including requirements', (await js(`document.querySelector('[data-map=links]').selectedOptions[0].textContent`)) === 'Coverage (Issues)');
check('HTML was detected and the option pre-ticked', await js(`document.querySelector('[data-html]').checked`) && (await text('.impopts')).includes('found in this file'));
check('default mode creates both', (await text('#imp-prev')).includes('2 test cases with 2 steps will be created'));
await setValue('[data-mode]', 'update_id', 'change'); await sleep(600);
const prev = await text('#imp-prev');
check('update-by-ID preview: 1 created, 1 updated, rows labelled', prev.includes('1 will be created and 1 updated') && prev.includes('Update DEMO-T1') && prev.includes('New'), prev.replace(/\n/g, ' ').slice(0, 220));
await shot('s14-import-update');
await js(`document.querySelector('#dlg form').requestSubmit()`); await sleep(1200);
check('toast says what happened', (await text('#toast')).includes('Created 1 test case') && (await text('#toast')).includes('updated 1'), await text('#toast'));
const c = await api('/api/cases/1');
check('the existing case was updated, not duplicated', c.title === 'Sign in (renamed by file)' && c.priority === 'High' && c.folder === 'Authentication' && (await api('/api/projects/1/cases')).filter((x) => x.title.startsWith('Sign in')).length === 1);
check('HTML was stripped from steps', c.steps.length === 1 && c.steps[0].action === 'Open the login page' && c.steps[0].expected === 'Form is shown\nwith fields', JSON.stringify(c.steps));
check('requirement links came from Coverage (Issues)', c.links.map((l) => l.ref).join() === 'PROJ-1,PROJ-2');
check('the other row was created', (await api('/api/projects/1/cases')).some((x) => x.title === 'A brand new case' && x.folder === 'Imports'));
check('the update made a new version with a note', (await api('/api/cases/1/versions'))[0].note === 'Updated by import');
check('no console errors', t.errors.filter((e) => !/status of (401|403|400)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
