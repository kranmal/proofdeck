// Stage 8 UI: non-image attachments and the screenshot annotator.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

// A white 400x300 PNG to draw on, uploaded to step 1 of run 2.
const png = await js(`(async () => { const c = document.createElement('canvas'); c.width = 400; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 300);
  return c.toDataURL('image/png').split(',')[1]; })()`);
const ex = await api('/api/executions/2');
const stepId = ex.steps[0].id;
await api(`/api/step-results/${stepId}`, 'PUT', { status: 'Fail', actual: 'broke' });
const att = await api(`/api/step-results/${stepId}/attachments`, 'POST', { filename: 'page.png', mime: 'image/png', data: png });

await go('#/run/2');
// upload a log and a PDF through the file input
await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['2026-11-11 ERROR boom\\n'], 'run.log', { type: '' })); dt.items.add(new File(['%PDF-1.4 fake'], 'report.pdf', { type: 'application/pdf' }));
  const inp = document.querySelector('.step input[data-upload]'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(1200);
check('log and PDF appear as file chips with names and sizes', (await count('.step .thumb.filechip')) === 2 && (await text('.step')).includes('run.log') && (await text('.step')).includes('report.pdf') && (await text('.step .filechip small')).includes('KB'));
check('file chips download (not open) and have a remove button', await js(`(() => { const a = document.querySelector('.step .filechip a.file'); return a.hasAttribute('download') && a.getAttribute('href').startsWith('/api/attachments/') && !!a.parentElement.querySelector('.x'); })()`));
const types = (await api('/api/executions/2')).steps[0].attachments.map((a) => a.mime);
check('log was labelled as text even though the browser gave no type', types.includes('text/plain') && types.includes('application/pdf'), JSON.stringify(types));
// unsupported file is reported, not silently dropped
await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['MZ'], 'virus.exe', { type: 'application/x-msdownload' }));
  const inp = document.querySelector('.step input[data-upload]'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(500);
check('an unsupported file is refused with a message', (await text('#toast')).includes('skipped'), await text('#toast'));
check('the image has an Annotate button; file chips do not', (await count('.step .thumb .ann')) === 1);

// ---- annotate
await js(`document.querySelector('.step .thumb .ann').click()`); await sleep(900);
check('annotator opens with the canvas at the image size', (await js(`(() => { const c = document.querySelector('#ann'); return c.width === 400 && c.height === 300; })()`)));
check('tools and colours are labelled buttons', (await count('[data-tool]')) === 4 && (await count('[data-color]')) === 4 && (await js(`document.querySelector('[data-tool=arrow]').getAttribute('aria-pressed')`)) === 'true');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
const box = await js(`(() => { const r = document.querySelector('#ann').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const at = (fx, fy) => ({ x: box.x + box.w * fx, y: box.y + box.h * fy });
async function drag(from, to) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
}
const px = (fx, fy) => js(`(() => { const c = document.querySelector('#ann'); const d = c.getContext('2d').getImageData(Math.round(${fx} * c.width), Math.round(${fy} * c.height), 1, 1).data; return [d[0], d[1], d[2]]; })()`);
const white = (p) => p.every((v) => v >= 250);
check('canvas starts white', white(await px(0.5, 0.5)));
await drag(at(0.1, 0.1), at(0.5, 0.1));        // red arrow along the top edge
const onArrow = await px(0.3, 0.1);
check('arrow draws in red', onArrow[0] > 200 && onArrow[1] < 90 && onArrow[2] < 120, JSON.stringify(onArrow));
await click('[data-color="#1478a8"]'); await click('[data-tool=box]');
await drag(at(0.2, 0.4), at(0.8, 0.8));        // blue box
const edge = await px(0.2, 0.6);
check('box draws in the chosen blue (edge pixel)', edge[2] > 120 && edge[0] < 80, JSON.stringify(edge));
check('box interior is untouched', white(await px(0.5, 0.6)));
await click('[data-color="#111111"]'); await click('[data-tool=pen]');
await drag(at(0.1, 0.3), at(0.9, 0.34));
check('pen draws a dark line', (await px(0.5, 0.32)).every((v) => v < 90), JSON.stringify(await px(0.5, 0.32)));
// text
await click('[data-color="#e5234b"]'); await click('[data-tool=text]');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at(0.3, 0.2), button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(0.3, 0.2), button: 'left', clickCount: 1 }); await sleep(200);
check('text tool shows an input', await visible('#ann-text'));
await js(`(() => { const i = document.querySelector('#ann-text'); i.value = 'BUG HERE'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`); await sleep(200);
check('text is committed and the input hidden', !(await visible('#ann-text')));
const shapesCount = await js(`(() => { const c = document.querySelector('#ann'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 0 && v > 200) })()`);
check('canvas contains red pixels from the text/arrow', shapesCount);
await shot('s8-annotator');
// undo removes the text, clear then save is refused
await click('[data-an=undo]'); await sleep(150);
await click('[data-an=clear]'); await sleep(150);
check('clear restores the clean image', white(await px(0.3, 0.1)) && white(await px(0.5, 0.32)));
await submit(); await sleep(300);
check('saving with nothing drawn is refused, dialog stays open', await js(`document.querySelector('#dlg').open`) && (await text('#toast')).includes('Draw something first'));
// draw again and save
await click('[data-tool=box]'); await click('[data-color="#e5234b"]');
await drag(at(0.25, 0.25), at(0.75, 0.75));
await submit(); await sleep(1200);
check('save closes the dialog and refreshes the thumbnail', !(await js(`document.querySelector('#dlg').open`)));
// the stored image really changed
const stored = await js(`(async () => { const r = await fetch('/api/attachments/${att.id}'); const b = await r.blob(); const bmp = await createImageBitmap(b); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); const left = g.getImageData(Math.round(0.25 * c.width), Math.round(0.5 * c.height), 1, 1).data; const mid = g.getImageData(Math.round(0.5 * c.width), Math.round(0.5 * c.height), 1, 1).data;
  return { w: c.width, h: c.height, left: [left[0], left[1], left[2]], mid: [mid[0], mid[1], mid[2]] }; })()`);
check('stored image is the annotated one (red box edge, white inside)', stored.w === 400 && stored.left[0] > 200 && stored.left[1] < 90 && stored.mid.every((v) => v >= 250), JSON.stringify(stored));
const meta = (await api('/api/executions/2')).steps[0].attachments.find((a) => a.id === att.id);
check('same attachment id and name kept', meta && meta.filename === 'page.png');
await shot('s8-after');

// bug dialog lists chips with checkboxes; files are copied to the bug
await js(`document.querySelector('.step [data-act=bug]').click()`); await sleep(900);
check('bug dialog shows the image and both files with tick boxes', (await count('#dlg .thumb.pick')) === 3 && (await count('#dlg .thumb.filechip.pick')) === 2);
await submit(); await sleep(1000);
const bugs = await api('/api/projects/1/bugs');
const bug = await api(`/api/bugs/${bugs[0].id}`);
check('all three attachments were copied to the bug', bug.attachments.length === 3 && bug.attachments.map((a) => a.mime).sort().join() === 'application/pdf,image/png,text/plain', bug.attachments.map((a) => a.mime).join());
await go(`#/bugs/${bug.id}`);
const bp = { thumbs: await count('#view .shots .thumb'), ann: await count('#view .shots .ann'), html: (await js(`document.querySelector('#view .shots').innerText`)).replace(/\n/g, ' | ') };
check('bug page shows image + files, with annotate only on the image', bp.thumbs === 3 && bp.ann === 1, JSON.stringify(bp));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
