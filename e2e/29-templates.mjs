// Case templates: save one from a case, start a new case from it, delete it.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, submit, field, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
await js(`window.confirm = () => true`);

await api('/api/cases/2', 'PUT', { objective: 'Cart objective', priority: 'High', labels: 'cart' });
await go('#/cases/2'); await sleep(800);
await click('[data-act=save-template]'); await sleep(400);
await field('name', 'Cart flow'); await submit(); await sleep(800);
check('the template is saved', (await api('/api/projects/1/templates')).length === 1 && (await text('#toast')).includes('Template saved'));

await go('#/cases'); await sleep(700);
await click('[data-act=from-template]'); await sleep(500);
check('the chooser lists it with its step count', (await text('#tpls')).includes('Cart flow') && (await text('#tpls')).includes('3 steps'));
await click('[data-use]'); await sleep(1200);
check('the new-case editor opens prefilled', (await js('location.hash')) === '#/cases/new' && (await js(`document.querySelector('#f-objective')?.value`)) === 'Cart objective' && (await js(`[...document.querySelectorAll('#view [data-f=action]')].filter((e) => e.value).length`)) === 3);
check('the title is empty and the priority comes from the template', (await js(`document.querySelector('#f-title').value`)) === '' && (await js(`document.querySelector('#f-priority').value`)) === 'High');
await js(`(() => { const e = document.querySelector('#f-title'); e.value = 'Guest checkout'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await click('[data-act=save]'); await sleep(1200);
const made = (await api('/api/projects/1/cases')).find((c) => c.title === 'Guest checkout');
check('saving creates a case with the template content', made && (await api(`/api/cases/${made.id}`)).steps.length === 3 && (await api(`/api/cases/${made.id}`)).objective === 'Cart objective');

await go('#/cases'); await sleep(500);
await click('[data-act=from-template]'); await sleep(500);
await click('[data-rmtpl]'); await sleep(700);
check('a template can be deleted from the chooser', (await api('/api/projects/1/templates')).length === 0 && (await text('#tpls')).includes('No templates yet'));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404|429)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
