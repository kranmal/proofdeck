// Drives the Proofdeck UI through Chrome DevTools Protocol: fail a step, paste a screenshot, create a bug.
import fs from 'node:fs';
const OUT = process.argv[2];
const APP = 'http://127.0.0.1:4791';
const tabs = await (await fetch('http://127.0.0.1:9333/json')).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0; const pending = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value).join(' '));
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(d.params.entry.text);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};
const go = async (hash) => { await js(`location.hash = ${JSON.stringify(hash)}`); await sleep(500); };
const check = (label, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  -> ' + extra : ''}`);

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.navigate', { url: APP + '/' }); await sleep(800);
await js(`fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', display_name: 'Ada Admin', password: 'correct horse battery' }) }).then(r => r.status)`);
await send('Page.navigate', { url: APP + '/?signedin=1' }); await sleep(900);
await send('Page.navigate', { url: APP + '/' }); await sleep(900);
check('overview renders tiles', await js(`document.querySelectorAll('.tile').length`) === 6);
await shot('1-overview');

await go('#/cases');
check('case list shows 3 seeded cases', await js(`document.querySelectorAll('#rows tr').length`) === 3);

// create a case through the editor
await go('#/cases/new');
await js(`(() => { document.querySelector('#f-title').value = 'UI made case';
  const t = document.querySelectorAll('.steprow textarea'); t[0].value = 'Do thing'; t[2].value = 'Thing happens';
  document.querySelector('[data-act=add]').click();
  const u = document.querySelectorAll('#steps .steprow:last-child textarea'); u[0].value = 'Second'; u[2].value = 'Second ok';
  document.querySelector('[data-act=save]').click(); })()`);
await sleep(600);
check('new case saved with 2 steps', await js(`fetch('/api/cases/4').then(r => r.json()).then(c => c.steps.length)`) === 2);

await go('#/cycles/1');
check('cycle lists 3 executions', await js(`document.querySelectorAll('tbody tr').length`) === 3);

// run DEMO-T2: pass step 1 via keyboard, fail step 2 with actual result
await go('#/run/2');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', text: 'p' }); await sleep(500);
check('keyboard P passes step 1', await js(`document.querySelector('.step').classList.contains('pass')`));
check('active moved to step 2', await js(`document.querySelectorAll('.step')[1].classList.contains('active')`));
await js(`(() => { const c = document.querySelectorAll('.step')[1]; c.querySelector('[data-actual]').value = 'Cart badge stays at 0';
  c.querySelector('[data-v=Fail]').click(); })()`);
await sleep(500);
check('step 2 failed, Create bug button visible', await js(`!!document.querySelectorAll('.step')[1].querySelector('[data-act=bug]')`));
check('no Create bug on passed step', await js(`!document.querySelector('.step').querySelector('[data-act=bug]')`));

// paste a screenshot onto the active (failed) step
await js(`(async () => { const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d');
  g.fillStyle = '#d6336c'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.font = '24px sans-serif'; g.fillText('Cart badge: 0', 70, 105);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'paste.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
await sleep(900);
check('pasted screenshot attached to step 2', await js(`document.querySelectorAll('.step')[1].querySelectorAll('.thumb').length`) === 1);
await shot('2-failed-step');

// open bug dialog and verify prefill
await js(`document.querySelectorAll('.step')[1].querySelector('[data-act=bug]').click()`); await sleep(700);
const pre = await js(`(() => { const f = document.querySelector('#dlg form'); return { open: document.querySelector('#dlg').open,
  title: f.elements.title.value, expected: f.elements.expected.value, actual: f.elements.actual.value,
  repro: f.elements.steps_to_reproduce.value, env: f.elements.environment.value, shots: f.querySelectorAll('[name=att]:checked').length }; })()`);
check('bug dialog open', pre.open);
check('expected prefilled', pre.expected === 'Cart badge shows 1', pre.expected);
check('actual prefilled', pre.actual === 'Cart badge stays at 0', pre.actual);
check('steps to reproduce prefilled up to failed step', /^Preconditions:/.test(pre.repro) && /\n2\. Press/.test(pre.repro) && !/3\. /.test(pre.repro), JSON.stringify(pre.repro));
check('environment prefilled', pre.env.includes('1.0.0-rc1'), pre.env);
check('screenshot ticked', pre.shots === 1);
await shot('3-bug-dialog');
await js(`(() => { const f = document.querySelector('#dlg form'); f.elements.steps_to_reproduce.value += '\\n3. Look at the cart badge'; f.requestSubmit(); })()`);
await sleep(900);
check('dialog closed after create', !(await js(`document.querySelector('#dlg').open`)));
check('bug chip on step', (await js(`document.querySelectorAll('.step')[1].querySelector('.chip')?.textContent || ''`)).includes('DEMO-B1'));
const bug = await js(`fetch('/api/bugs/1').then(r => r.json())`);
check('bug stored with edited repro steps', bug.steps_to_reproduce.endsWith('3. Look at the cart badge'));
check('bug has screenshot copy', bug.attachments.length === 1 && bug.attachments[0].size > 500, JSON.stringify(bug.attachments));
check('bug traceability', bug.case_key === 'DEMO-T2' && bug.step_no === 2 && bug.cycle_key === 'DEMO-C1');

await go('#/bugs/1');
check('bug page shows screenshot', await js(`document.querySelectorAll('.shots.large .thumb img').length`) === 1);
check('bug image loads', await js(`document.querySelector('.shots.large img').naturalWidth`) === 320);
await js(`(() => { document.querySelector('#b-status').value = 'Resolved'; document.querySelector('[data-act=save]').click(); })()`); await sleep(500);
check('bug status saved', (await js(`fetch('/api/bugs/1').then(r => r.json())`)).status === 'Resolved');
await shot('4-bug-page');
await go('#/bugs');
await go('#/');
check('no console / runtime errors', errors.length === 0, errors.join(' | '));
ws.close();
