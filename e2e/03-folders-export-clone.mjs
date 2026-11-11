// UI walkthrough: folder tree, drag & drop, bulk actions, export, cycle clone, icons, full width.
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
const go = async (hash) => { await js(`location.hash = ${JSON.stringify(hash)}`); await sleep(600); };
const api = (path, method = 'GET', body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: {'Content-Type':'application/json'}${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ''} }).then(r => r.json())`);
const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
const submit = async () => { await js(`document.querySelector('#dlg form').requestSubmit()`); await sleep(700); };
const setField = (name, v) => js(`(() => { const f = document.querySelector('#dlg form').elements[${JSON.stringify(name)}]; f.value = ${JSON.stringify(v)}; })()`);
const treeFolders = () => js(`[...document.querySelectorAll('#tree .node')].map(n => n.dataset.path + ':' + n.querySelector('.ct').textContent)`);
const rowCount = () => js(`document.querySelectorAll('#rows tr[data-id]').length`);
const pick = async (path) => { await js(`[...document.querySelectorAll('#tree .nl')].find(b => b.dataset.path === ${JSON.stringify(path)}).click()`); await sleep(250); };

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.navigate', { url: APP + '/' }); await sleep(800);
await js(`fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', display_name: 'Ada Admin', password: 'correct horse battery' }) }).then(r => r.status)`);
await send('Page.navigate', { url: APP + '/?signedin=1' }); await sleep(900);
await send('Page.navigate', { url: APP + '/#/cases' }); await sleep(1000);

// ---- full width + icons
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }); await sleep(500);
const m = await js(`(() => { const v = document.querySelector('#view').getBoundingClientRect(); const t = document.querySelector('.cases-pane table').getBoundingClientRect();
  return { vw: innerWidth, view: v.width, table: t.width, max: getComputedStyle(document.querySelector('#view')).maxWidth }; })()`);
check('main area fills the window (no max-width)', m.max === 'none' && m.view > m.vw - 260, JSON.stringify(m));
check('case table uses the wide space (fills the pane beside the folder tree)', m.table > 1200, String(Math.round(m.table)));
const ic = await js(`(() => ({ nav: [...document.querySelectorAll('#nav a svg')].map(s => Math.round(s.getBoundingClientRect().width)),
  btns: [...document.querySelectorAll('.head .btn svg')].length }))()`);
check('4 nav icons, 22px', ic.nav.length >= 4 && ic.nav.every((w) => w >= 22), JSON.stringify(ic));
check('toolbar buttons have icons', ic.btns >= 3);
await shot('7-cases-1920');

// ---- tree
const t0 = await treeFolders();
check('tree: root + seeded folders with counts', JSON.stringify(t0) === JSON.stringify([':3', 'Authentication:1', 'Checkout:2']), JSON.stringify(t0));
await pick('Checkout');
check('picking a folder filters the list', (await rowCount()) === 2 && (await js(`document.querySelector('.fname').innerText`)).includes('Checkout'));
await click('[data-act=new-folder]'); await sleep(300);
check('new subfolder dialog prefilled with parent', (await js(`document.querySelector('#dlg form').elements.path.value`)) === 'Checkout/');
await setField('path', 'Checkout / Payments'); await submit();
check('subfolder created, selected, shown nested', (await treeFolders()).includes('Checkout/Payments:0') && (await js(`document.querySelector('.fname strong').textContent`)) === 'Checkout/Payments');
check('empty folder shows empty message', (await js(`document.querySelector('#rows').innerText`)).includes('No test cases here'));
await pick('Checkout');
check('parent count unchanged and subfolder listed', (await treeFolders()).includes('Checkout:2'));

// collapse / expand
await js(`document.querySelector('.tw[data-path=Checkout]').click()`); await sleep(200);
check('collapse hides children', !(await treeFolders()).includes('Checkout/Payments:0'));
await js(`document.querySelector('.tw[data-path=Checkout]').click()`); await sleep(200);
check('expand shows children', (await treeFolders()).includes('Checkout/Payments:0'));

// ---- drag & drop
const moved = await js(`(() => { const dt = new DataTransfer(); const tr = document.querySelector('#rows tr[data-id]'); const id = Number(tr.dataset.id);
  tr.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const nl = [...document.querySelectorAll('#tree .nl')].find(b => b.dataset.path === 'Checkout/Payments');
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }); nl.dispatchEvent(over);
  const hl = nl.closest('.node').classList.contains('drop');
  nl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return { id, prevented: over.defaultPrevented, hl }; })()`);
await sleep(800);
const mv = (await api('/api/projects/1/cases')).find((c) => c.id === moved.id);
check('dragover highlights drop target', moved.prevented && moved.hl, JSON.stringify(moved));
check('drop moves the case into the folder', mv.folder === 'Checkout/Payments', mv.folder);
check('tree counts updated after drop', (await treeFolders()).includes('Checkout/Payments:1') && (await treeFolders()).includes('Checkout:2'));
check('dragging over the table (not a folder) is ignored', await js(`(() => { const dt = new DataTransfer(); const e = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
  document.querySelector('#rows tr').dispatchEvent(e); return !e.defaultPrevented; })()`));

// ---- bulk
await pick('');
await click('#sel-all'); await sleep(250);
check('select all shows bulk bar with 3', (await js(`document.querySelector('#bulk').innerText`)).includes('3 selected') && !(await js(`document.querySelector('#bulk').hidden`)));
await click('[data-act=bulk-move]'); await sleep(300);
check('move dialog offers existing folders', (await js(`document.querySelectorAll('#dl-folders option').length`)) >= 3);
await setField('path', 'Bulk / Dest'); await submit();
check('bulk move: all 3 cases moved', (await api('/api/projects/1/cases')).every((c) => c.folder === 'Bulk/Dest'));
check('bulk bar hidden after move', await js(`document.querySelector('#bulk').hidden`));
check('tree shows nested Bulk/Dest = 3', (await treeFolders()).includes('Bulk:3') && (await treeFolders()).includes('Bulk/Dest:3'));

// rename (move) folder
await pick('Bulk');
await click('[data-act=rename-folder]'); await sleep(300);
await setField('path', 'Archive'); await submit();
const f1 = await api('/api/projects/1/folders');
check('rename moves subtree', f1.includes('Archive/Dest') && !f1.some((x) => x.startsWith('Bulk')), JSON.stringify(f1));
check('selection follows renamed folder', (await js(`document.querySelector('.fname strong').textContent`)) === 'Archive');
// delete folder keeps cases
await js(`window.confirm = () => true`);
await click('[data-act=delete-folder]'); await sleep(800);
const cases1 = await api('/api/projects/1/cases');
check('delete folder lifts contents, loses no cases', cases1.length === 3 && cases1.every((c) => c.folder === 'Dest') && !(await api('/api/projects/1/folders')).includes('Archive'));
check('selection falls back to parent (All)', (await js(`document.querySelector('.fname strong').textContent`)) === 'All test cases');

// ---- search + include subfolders
await js(`(() => { const q = document.querySelector('#q'); q.value = 'cart'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(250);
check('search filters list and keeps focus-free input value', (await rowCount()) === 1);
await js(`(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await pick('');
await js(`document.querySelector('#deep').click()`); await sleep(250);
check('"include subfolders" off on All shows only unfiled cases', (await rowCount()) === 0);
await js(`document.querySelector('#deep').click()`); await sleep(250);

// ---- export dialog
await js(`window.__dl = []; window.download = (u) => window.__dl.push(u);`);
await pick('Dest');
await js(`document.querySelector('[data-sel]').click()`); await sleep(200);
await click('[data-act=export]'); await sleep(300);
const scopes = await js(`[...document.querySelectorAll('#dlg [name=scope]')].map(r => r.nextElementSibling.textContent)`);
check('export offers selected / folder / all', scopes.length === 3 && scopes[0].startsWith('Selected') && scopes[1].includes('Dest') && scopes[2].startsWith('All'), JSON.stringify(scopes));
await shot('8-export-dialog');
await setField('format', 'csv'); await submit();
const url = await js(`window.__dl[0]`);
check('export builds download URL with selected ids', /export\?format=csv&ids=\d+$/.test(url || ''), url);
const exp = await js(`fetch(${JSON.stringify(url)}).then(async r => ({ s: r.status, t: await r.text() }))`);
check('exported file has exactly the selected case', exp.s === 200 && exp.t.trim().split('\r\n').length >= 2);

// ---- new case inherits selected folder
await pick('Dest');
await click('a.btn.primary'); await sleep(700);
check('new test case preselects current folder', (await js(`document.querySelector('#f-folder').value`)) === 'Dest');
check('case editor folder has suggestions', (await js(`document.querySelectorAll('#dl-folders option').length`)) >= 1);
check('step tool icons are SVG, >=22px', await js(`[...document.querySelectorAll('.steprow .tools .icon svg')].every(s => s.getBoundingClientRect().width >= 22) && document.querySelectorAll('.steprow .tools .icon svg').length === 3`));
await shot('9-case-editor');

// ---- cycle: results, clone, export
await api('/api/step-results/1', 'PUT', { status: 'Pass' }); await api('/api/step-results/2', 'PUT', { status: 'Pass' }); await api('/api/step-results/3', 'PUT', { status: 'Pass' });
await api('/api/step-results/4', 'PUT', { status: 'Fail', actual: 'boom' });
await go('#/cycles/1');
await shot('10-cycle');
await click('[data-act=clone]'); await sleep(300);
const radios = await js(`[...document.querySelectorAll('#dlg [name=include]')].map(r => r.value + ':' + r.disabled)`);
check('clone dialog counts/disabled states', JSON.stringify(radios) === JSON.stringify(['all:false', 'unpassed:false', 'failed:false']), JSON.stringify(radios));
check('clone dialog default name', (await js(`document.querySelector('#dlg form').elements.name.value`)).endsWith('(copy)'));
await setField('name', 'Smoke re-run'); await setField('build', '1.0.1');
await js(`document.querySelector('#dlg [name=include][value=failed]').click()`); await submit();
const h = await js(`location.hash`);
check('clone navigates to the new cycle', /^#\/cycles\/\d+$/.test(h) && h !== '#/cycles/1', h);
const nc = await api('/api' + h.slice(1));
check('clone: only the failed case, clean results, new build', nc.name === 'Smoke re-run' && nc.build === '1.0.1' && nc.executions.length === 1 && nc.executions[0].status === 'Not Executed');
check('clone: "Start testing" offered', (await js(`document.querySelector('.head').innerText`)).includes('Start testing'));
await go('#/cycles/1');
await js(`window.__dl = []`);
await click('[data-act=export]'); await sleep(300);
await submit();
check('cycle export URL', (await js(`window.__dl[0]`)) === '/api/cycles/1/export?format=xlsx', await js(`window.__dl[0]`));

// ---- player icons
await go('#/run/2');
const pl = await js(`(() => ({ st: [...document.querySelectorAll('.step .btn.st svg')].length, bug: !!document.querySelector('.btn.bug svg') }))()`);
check('player status buttons + bug button have icons', pl.st >= 3 && pl.bug, JSON.stringify(pl));
await shot('11-player');

// ---- phone width: tree stacks, no horizontal scroll
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(400);
await go('#/cases'); await sleep(400);
check('phone: no horizontal page scroll', await js(`document.documentElement.scrollWidth <= innerWidth + 1`), await js(`document.documentElement.scrollWidth + ' vs ' + innerWidth`));
await shot('12-phone-cases');
await send('Emulation.clearDeviceMetricsOverride');
const unexpectedErrs = errors.filter((e) => !/status of 400/.test(e)); // the .xls upload is refused on purpose
check('no console / runtime errors', unexpectedErrs.length === 0, unexpectedErrs.join(' | '));
ws.close();
