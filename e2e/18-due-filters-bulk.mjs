// Cycle due dates + overdue, report filters, bulk edit of test cases and bugs.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, setValue, field, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

// ---- due dates
const past = '2020-01-15', future = '2099-12-31';
await go('#/cycles'); await click('[data-act=new]'); await sleep(600);
check('the new-cycle dialog has start and due date inputs', await exists('#dlg [name=start_date]') && await exists('#dlg [name=due_date]'));
await field('name', 'Late cycle'); await field('start_date', '2020-01-01'); await field('due_date', past);
await js(`document.querySelector('#dlg input[name=case]').click()`);
await submit(); await sleep(900);
check('the cycle page shows the due date and Overdue', (await text('.meta')).includes(past) && (await text('.meta')).includes('Overdue'), await text('.meta'));
await go('#/cycles');
check('the list shows the due date with an Overdue pill', (await text('#view table')).includes(past) && (await text('#view table')).includes('Overdue'));
await api('/api/projects/1/cycles', 'POST', { name: 'Future cycle', caseIds: [1], due_date: future });
await go('#/cycles');
await setValue('#cyfilter', 'overdue', 'change'); await sleep(400);
check('the Overdue filter keeps only the late cycle', (await text('#view table')).includes('Late cycle') && !(await text('#view table')).includes('Future cycle'));
await setValue('#cyfilter', 'all', 'change'); await sleep(300);
await go('#/');
check('the overview has an overdue tile that opens the filtered list', (await text('.tiles')).includes('Overdue test cycle'));
await js(`document.querySelector('.tile[data-overdue]').click()`); await sleep(800);
check('and lands on the Overdue filter', (await js(`document.querySelector('#cyfilter').value`)) === 'overdue');
await setValue('#cyfilter', 'all', 'change'); await sleep(200);

// ---- report filters
await go('#/reports');
check('the report filter bar is shown', await exists('[data-rf=from]') && await exists('[data-rf=plan_id]'));
await setValue('[data-rf=label]', 'no-such-label-xyz');
await click('[data-act=apply-filters]'); await sleep(900);
check('a filter with no matches shows a filtered, empty view', (await text('#view')).includes('Filtered view') && (await exists('[data-act=clear-filters]')));
await click('[data-act=clear-filters]'); await sleep(900);
check('clearing brings back the unfiltered report', !(await text('#view')).includes('Filtered view'));
await setValue('[data-rf=from]', '2099-01-01'); await setValue('[data-rf=to]', '2099-01-31');
await click('[data-act=apply-filters]'); await sleep(900);
check('a date window with nothing in it filters everything out', (await text('#view')).includes('Filtered view'));
await click('[data-act=clear-filters]'); await sleep(600);

// ---- bulk edit cases
await go('#/cases');
await js(`document.querySelector('#sel-all').click()`); await sleep(300);
await click('[data-act=bulk-edit]'); await sleep(500);
await field('priority', 'Low'); await field('mode', 'add'); await field('labels', 'Bulk, smoke'); await submit(); await sleep(1000);
const cases = await api('/api/projects/1/cases');
check('every selected case got the priority', cases.every((c) => c.priority === 'Low'));
check('and the labels were added', cases.every((c) => c.labels.toLowerCase().includes('bulk') && c.labels.toLowerCase().includes('smoke')));

// ---- bulk edit bugs
const ex = await api('/api/executions/2');
await api(`/api/step-results/${ex.steps[0].id}`, 'PUT', { status: 'Fail', actual: 'x' });
const b1 = await api(`/api/step-results/${ex.steps[0].id}/bug`, 'POST', {});
await api('/api/projects/1/bugs', 'POST', { title: 'Second bug' });
await go('#/bugs');
check('bug rows have checkboxes', (await count('#rows input[data-sel]')) >= 2);
await js(`document.querySelector('#bsel-all').click()`); await sleep(300);
check('selecting shows the bulk bar', (await text('#bbulk')).includes('selected'));
await click('[data-act=bbulk-edit]'); await sleep(500);
await field('status', 'In Progress'); await field('severity', 'Minor'); await submit(); await sleep(1000);
const bugs = await api('/api/projects/1/bugs');
check('every selected bug moved to In Progress with the new severity', bugs.length >= 2 && bugs.every((b) => b.status === 'In Progress' && b.severity === 'Minor'), JSON.stringify(bugs.map((b) => [b.status, b.severity])));
check('assignee was left alone', bugs.some((b) => b.id === b1.id));
await shot('s18-bulk');
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|502)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
