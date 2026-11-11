// UI walkthrough for import dialog + standalone runs.
import fs from 'node:fs';
const OUT = process.argv[2];
const XLSX = fs.readFileSync((process.argv[3] || new URL('./fixtures/cases.xlsx', import.meta.url).pathname)).toString('base64');
const APP = 'http://127.0.0.1:4791';
const tabs = await (await fetch('http://127.0.0.1:9333/json')).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0; const pending = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(d.params.entry.text + ' ' + (d.params.entry.url || ''));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result.result.value;
};
const shot = async (name) => fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
const check = (label, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  -> ' + extra : ''}`);
const pickFile = (b64, name, type) => js(`(() => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([u], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  const inp = document.querySelector('#dlg input[type=file]'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`);

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.navigate', { url: APP + '/' }); await sleep(800);
await js(`fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', display_name: 'Ada Admin', password: 'correct horse battery' }) }).then(r => r.status)`);
await send('Page.navigate', { url: APP + '/?signedin=1' }); await sleep(900);
await send('Page.navigate', { url: APP + '/#/cases' }); await sleep(1000);
const before = await js(`document.querySelectorAll('#rows tr').length`);

// --- Excel import through the dialog ---
await js(`document.querySelector('[data-act=import]').click()`); await sleep(300);
check('import dialog open, Import disabled', await js(`document.querySelector('#dlg').open && document.querySelector('#imp-go').disabled`));
await pickFile(XLSX, 'cases.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); await sleep(1200);
check('auto-picked the sheet with test cases', await js(`document.querySelector('[data-sheet]')?.selectedOptions[0].textContent`) === 'Test Cases');
check('title column auto-mapped', await js(`document.querySelector('[data-map=title]').selectedOptions[0].textContent`) === 'Test Case Name');
check('expected column auto-mapped', await js(`document.querySelector('[data-map=expected]').selectedOptions[0].textContent`) === 'Expected Result');
const prev = await js(`document.querySelector('#imp-prev').innerText`);
check('preview: 2 cases, 4 steps', /2\s+test cases with\s+4\s+steps/.test(prev.replace(/\n/g, ' ')), prev.split('\n')[0]);
check('preview escapes markup in titles', await js(`document.querySelector('#imp-prev table').innerText.includes('Checkout & pay <card>')`));
await shot('5-import-dialog');
// unmap title -> blocked; remap -> allowed
await js(`(() => { const s = document.querySelector('[data-map=title]'); s.value = '-1'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(400);
check('unmapping title disables Import', await js(`document.querySelector('#imp-go').disabled`));
await js(`(() => { const s = document.querySelector('[data-map=title]'); s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(500);
check('remapping title enables Import', !(await js(`document.querySelector('#imp-go').disabled`)));
await js(`document.querySelector('#dlg form').requestSubmit()`); await sleep(1000);
check('dialog closed, list grew by 2', !(await js(`document.querySelector('#dlg').open`)) && (await js(`document.querySelectorAll('#rows tr').length`)) === before + 2, `${before} -> ${await js(`document.querySelectorAll('#rows tr').length`)}`);

// --- bad file ---
await js(`document.querySelector('[data-act=import]').click()`); await sleep(300);
await pickFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]).toString('base64'), 'old.xls', 'application/vnd.ms-excel'); await sleep(600);
check('old .xls gives a clear error', (await js(`document.querySelector('#imp').innerText`)).includes('not supported'));
await js(`document.querySelector('#dlg [data-close]').click()`); await sleep(200);

// --- standalone run from the list ---
await js(`document.querySelector('#rows [data-act=run]').click()`); await sleep(900);
const hash1 = await js(`location.hash`);
check('Run opens the player', /^#\/run\/\d+$/.test(hash1), hash1);
check('player marked as standalone run', (await js(`document.querySelector('.head').innerText`)).includes('Standalone run'));
check('no previous/next links', await js(`![...document.querySelectorAll('.head a')].some(a => /Previous|Next/.test(a.textContent))`));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', text: 'f' }); await sleep(600);
check('can fail a step and create bug in standalone run', await js(`!!document.querySelector('.step [data-act=bug]')`));
await shot('6-standalone-run');
await js(`document.querySelector('[data-act=rerun]').click()`); await sleep(900);
const hash2 = await js(`location.hash`);
check('Run again starts a fresh run', hash2 !== hash1 && (await js(`document.querySelectorAll('.step.fail').length`)) === 0, hash2);

// --- run from the editor + history ---
await js(`location.hash = '#/cases/1'`); await sleep(600);
check('case page shows run history', (await js(`document.querySelector('#view').innerText`)).includes('Run history'));
await js(`document.querySelector('[data-act=run]').click()`); await sleep(900);
check('Run from case editor opens player', /^#\/run\/\d+$/.test(await js(`location.hash`)));
await js(`location.hash = '#/cycles'`); await sleep(600);
check('cycles list shows Standalone runs', (await js(`document.querySelector('#view').innerText`)).includes('Standalone runs'));
const unexpectedErrs = errors.filter((e) => !/status of 400/.test(e)); // the .xls upload is refused on purpose
check('no console / runtime errors', unexpectedErrs.length === 0, unexpectedErrs.join(' | '));
ws.close();
