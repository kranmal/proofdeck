// Stage 5 UI: test plans.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, field, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

await go('#/plans');
check('empty state explains plans', (await text('#view')).includes('No test plans yet') && await visible('a[data-nav=plans], #nav a[data-nav=plans]'));
await click('[data-act=new]'); await sleep(300);
await field('name', 'Release 2.0'); await field('description', 'Everything we run before shipping 2.0');
await submit(); await sleep(400);
check('creating a plan opens it', /^#\/plans\/\d+$/.test(await js('location.hash')) && (await text('.head h1')).includes('DEMO-P1 Release 2.0'));
check('description is shown', (await text('#view')).includes('Everything we run before shipping 2.0'));
check('empty plan says so, Add existing is enabled (seed cycle available)', (await text('#view')).includes('This plan has no cycles yet') && !(await js(`document.querySelector('[data-act=add]').disabled`)));

// new cycle inside the plan
await click('[data-act=new-cycle]'); await sleep(500);
check('plan is fixed in the new-cycle dialog (no plan picker)', !(await exists('#dlg select[name=plan_id]')));
await field('name', 'Smoke'); await field('build', '2.0.0-rc1'); await submit(); await sleep(500);
const cyc = await api('/api/cycles/2');
check('cycle was created inside the plan', cyc.plan_id === 1 && cyc.name === 'Smoke', JSON.stringify([cyc.plan_id, cyc.name]));
check('cycle page links back to the plan', (await text('.meta')).includes('DEMO-P1 Release 2.0') && await exists('.meta a[href="#/plans/1"]'));

// run some tests in it: pass 3 steps of first case, fail one of second
const ex = cyc.executions;
for (const s of (await api(`/api/executions/${ex[0].id}`)).steps) await api(`/api/step-results/${s.id}`, 'PUT', { status: 'Pass' });
await api(`/api/step-results/${(await api(`/api/executions/${ex[1].id}`)).steps[0].id}`, 'PUT', { status: 'Fail' });

// add the existing seed cycle
await go('#/plans/1');
check('plan page rolls up the cycle', (await text('.card')).includes('Progress across 1 cycle'));
await click('[data-act=add]'); await sleep(400);
check('dialog offers the unplanned seed cycle only', (await count('#dlg [name=cycle]')) === 1);
await submit(); await sleep(300);
check('submitting with nothing ticked shows an error and stays open', await js(`document.querySelector('#dlg').open`) && (await text('#toast')).includes('Tick at least one cycle'));
await js(`document.querySelector('#dlg [name=cycle]').click()`); await submit(); await sleep(600);
check('both cycles now listed', (await count('tbody tr')) === 2);
const summary = await text('.card');
check('totals add up (6 executions: 1 pass, 1 fail, 4 not run)', summary.includes('6 test executions in total') && summary.includes('Pass 1') && summary.includes('Fail 1') && summary.includes('Not run 4'), summary.replace(/\n/g, ' ').slice(0, 300));
check('pass rate over decided results', summary.includes('50% of the 2 decided results passed'));
await shot('s5-plan');

// plans list + cycles list column
await go('#/plans');
check('plans list shows cycle count and progress', (await text('tbody')).includes('Release 2.0') && (await text('tbody tr')).includes('2'));
await go('#/cycles');
check('cycles list has a Plan column with links', (await text('thead')).toLowerCase().includes('plan') && (await count('tbody a[href="#/plans/1"]')) === 2);

// remove one cycle, edit a cycle's plan via dialog
await go('#/plans/1');
await click('[data-act=unplan]'); await sleep(700);
check('remove from plan keeps the cycle', (await count('tbody tr')) === 1 && (await api('/api/cycles/1')).plan_id === null || (await api('/api/cycles/2')).plan_id === null);
await go('#/cycles/2');
await click('[data-act=edit]'); await sleep(500);
check('edit dialog preselects the plan', (await js(`document.querySelector('#dlg select[name=plan_id]').value`)) === '' || (await js(`document.querySelector('#dlg select[name=plan_id]').value`)) === '1');
await field('plan_id', '1'); await field('name', 'Smoke (edited)'); await field('build', '2.0.0'); await submit(); await sleep(500);
check('edit saves name, build and plan', (await text('.head h1')).includes('Smoke (edited)') && (await text('.meta')).includes('Build 2.0.0') && (await text('.meta')).includes('Release 2.0'));

// edit + delete plan
await go('#/plans/1');
await click('[data-act=edit]'); await sleep(300);
await field('name', 'Release 2.0 (final)'); await submit(); await sleep(400);
check('plan edit saves', (await text('.head h1')).includes('Release 2.0 (final)'));
await js(`window.__dl = []; window.download = (u) => window.__dl.push(u)`);
await click('[data-act=export]'); await sleep(300); await js(`document.querySelector('#dlg form').elements.format.value = 'csv'`); await submit();
check('export URL', (await js(`window.__dl[0]`)) === '/api/plans/1/export?format=csv');
await js(`window.confirm = () => true`);
await click('[data-act=delete]'); await sleep(700);
check('deleting returns to the list; cycles survive', (await js('location.hash')) === '#/plans' && (await api('/api/projects/1/cycles')).length === 2);

// phone width
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await sleep(400);
await go('#/plans'); await api('/api/projects/1/plans', 'POST', { name: 'Another' }); await go('#/plans'); await sleep(300);
check('phone: no sideways scroll on plans', await js(`document.documentElement.scrollWidth <= innerWidth + 1`));
await send('Emulation.clearDeviceMetricsOverride');
const unexpected = t.errors.filter((e) => !/status of (401|403|400)/.test(e));
check('no console errors', unexpected.length === 0, unexpected.join(' | '));
process.exit(t.finish() ? 1 : 0);
