// Custom fields, review/approval across two users, strict approval, and the Gherkin editor.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, field, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
const signOut = async () => { await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(700); };
const signIn = async (u, p) => { await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = ${JSON.stringify(u)}; f.password.value = ${JSON.stringify(p)}; f.requestSubmit(); })()`); await sleep(1300); };
await api('/api/users', 'POST', { username: 'tess', display_name: 'Tess Tester', password: 'tess password 1', role: 'tester' });
await api('/api/users', 'POST', { username: 'rae', display_name: 'Rae Reviewer', password: 'rae password 12', role: 'tester' });

// ---- fields admin page
await go('#/custom-fields');
check('Fields page lists the three kinds of record', (await text('#view')).includes('Test cases') && (await text('#view')).includes('Bugs') && (await text('#view')).includes('Test cycles'));
const addField = async (entity, label, type, extra = {}) => {
  await js(`document.querySelector('[data-act=add][data-entity=${entity}]').click()`); await sleep(300);
  await field('label', label); await field('type', type);
  if (type === 'select') { await js(`document.querySelector('#dlg form').elements.type.dispatchEvent(new Event('change'))`); await field('options', extra.options); }
  if (extra.required) await js(`document.querySelector('#dlg form').elements.required.click()`);
  await submit(); await sleep(500);
};
await addField('case', 'Component', 'select', { options: 'Web\nAPI\nMobile' });
await addField('case', 'Owner team', 'text', { required: true });
await addField('bug', 'Customer impact', 'select', { options: 'None\nSome\nMany' });
await addField('cycle', 'Sprint', 'number');
check('fields are listed with their type and options', (await text('#view')).includes('Component') && (await text('#view')).includes('Web, API, Mobile') && (await text('#view')).includes('Owner team'));
await js(`document.querySelector('[data-act=edit]').click()`); await sleep(300);
check('edit dialog offers archive and delete', await exists('#dlg [name=archived]') && await exists('#dlg [data-del]'));
await js(`document.querySelector('#dlg [data-close]').click()`); await sleep(200);

// ---- the fields on a case; required is enforced
await go('#/cases/1');
check('the case page shows the custom fields', await exists('[data-cf=component]') && await exists('[data-cf=owner_team]'));
await click('[data-act=save]'); await sleep(800);
check('a required field blocks saving with a clear message', (await text('#toast')).includes('“Owner team” is required'), await text('#toast'));
await setValue('[data-cf=owner_team]', 'Payments'); await setValue('[data-cf=component]', 'API', 'change');
await click('[data-act=save]'); await sleep(900);
check('values are saved', JSON.stringify((await api('/api/cases/1')).fields) === JSON.stringify({ component: 'API', owner_team: 'Payments' }));

// bug + cycle fields
const ex = await api('/api/executions/2');
await api(`/api/step-results/${ex.steps[0].id}`, 'PUT', { status: 'Fail', actual: 'x' });
const bug = await api(`/api/step-results/${ex.steps[0].id}/bug`, 'POST', {});
await go(`#/bugs/${bug.id}`);
await setValue('[data-cf=customer_impact]', 'Many', 'change'); await click('[data-act=save]'); await sleep(800);
check('a bug stores its field', (await api(`/api/bugs/${bug.id}`)).fields.customer_impact === 'Many');
await go('#/cycles'); await click('[data-act=new]'); await sleep(600);
check('the new-cycle dialog has the cycle field', await exists('#dlg [data-cf=sprint]'));
await field('name', 'Fields cycle'); await setValue('#dlg [data-cf=sprint]', '42'); await submit(); await sleep(800);
check('and it is saved on the cycle', (await api('/api/projects/1/cycles'))[0].name === 'Fields cycle' && (await api(`/api/cycles/${(await api('/api/projects/1/cycles'))[0].id}`)).fields.sprint === '42');

// ---- strict approval + review across users
const rv = await api('/api/projects/1/cases', 'POST', { title: 'Review me', steps: [{ action: 'Do it', expected: 'Done' }], fields: { owner_team: 'QA' } });
await go('#/custom-fields');
await js(`document.querySelector('#strict').click()`); await sleep(500);
check('strict approval can be switched on', (await api('/api/projects/1/workflow')).strictApproval === true);
await signOut(); await signIn('tess', 'tess password 1');
await go(`#/cases/${rv.id}`);
await setValue('[data-cf=owner_team]', 'QA');
await setValue('#f-status', 'Approved', 'change'); await click('[data-act=save]'); await sleep(900);
check('with strict approval a tester cannot just set Approved', (await text('#toast')).includes('approved through a review'), await text('#toast'));
await go(`#/cases/${rv.id}`);
await click('[data-act=request-review]'); await sleep(400);
const rae = await js(`[...document.querySelector('#dlg [name=reviewer_id]').options].find(o => o.textContent.includes('Rae')).value`);
await field('reviewer_id', rae); await field('note', 'Check the expected results'); await submit(); await sleep(900);
check('the case is now In Review with a banner', (await text('.banner')).includes('In review') && (await text('.banner')).includes('Rae Reviewer') && (await text('.banner')).includes('Waiting for the reviewer'));
check('the author cannot approve their own', !(await exists('[data-act=approve]')) && await exists('[data-act=withdraw]'));
await signOut(); await signIn('rae', 'rae password 12');
check('the reviewer’s overview has a tile for it', (await text('.tiles')).includes('waiting for your review'));
await js(`document.querySelector('.tile[data-review]').click()`); await sleep(800);
check('the tile opens the list filtered to In Review', (await js(`document.querySelector('#status-filter').value`)) === 'In Review' && (await count('#rows tr[data-id]')) === 1 && (await text('#rows')).includes('Review me'));
await js(`document.querySelector('#rows tr[data-id] a').click()`); await sleep(800);
check('the reviewer sees Approve and Request changes', await exists('[data-act=approve]') && await exists('[data-act=reject]'));
await click('[data-act=reject]'); await sleep(300);
await field('note', 'Expected result of step 2 is vague'); await submit(); await sleep(900);
check('requesting changes returns it to Draft with the reason shown', (await text('.banner')).includes('Changes were requested') && (await text('.banner')).includes('vague'));
await signOut(); await signIn('tess', 'tess password 1');
await go('#/notifications');
check('the author was told', (await text('.notifs')).includes('Rae Reviewer asked for changes'));
await go(`#/cases/${rv.id}`); await click('[data-act=request-review]'); await sleep(300); await field('reviewer_id', rae); await submit(); await sleep(800);
await signOut(); await signIn('rae', 'rae password 12');
await go(`#/cases/${rv.id}`); await click('[data-act=approve]'); await sleep(300); await field('note', 'Good now'); await submit(); await sleep(900);
check('approving shows who approved it', (await text('.banner')).includes('Approved') && (await text('.banner')).includes('Rae Reviewer') && (await js(`document.querySelector('#f-status').value`)) === 'Approved');

// ---- Gherkin
await signOut(); await signIn('admin', 'correct horse battery');
await go('#/cases/3');
await setValue('[data-cf=owner_team]', 'Pricing');
await click('[data-script=bdd]'); await sleep(200);
check('the editor switches to a Gherkin box and hides steps and data sets', await visible('#f-bdd') && !(await visible('#steps')) && !(await visible('#params')));
await setValue('#f-bdd', 'Scenario: broken\n  Given a thing\n  nonsense here');
await click('[data-act=save]'); await sleep(900);
check('a script that does not parse is refused with the line', (await text('#toast')).includes('The Gherkin script has a problem: line 3'), await text('#toast'));
const script = `Feature: Discounts
  Scenario Outline: Apply <code>
    Given a cart worth <amount>
    When the customer applies the code "<code>"
    Then the total is reduced by <percent>
    Examples:
      | code      | amount | percent |
      | WELCOME10 | 100    | 10%     |
      | VIP20     | 200    | 20%     |`;
await setValue('#f-bdd', script);
await click('[data-act=save]'); await sleep(1000);
await go('#/cases'); await go('#/cases/3'); await sleep(300);
check('after saving, the steps as they will run and the example count are shown', (await text('.bddsteps')).includes('When the customer applies the code "{{code}}"') && (await text('#bdd-box')).includes('2 example rows = 2 runs'));
await shot('s17-gherkin');
await go('#/cases');
check('the list shows Gherkin instead of a step count', (await text('#rows')).includes('Gherkin'));
const cyc = await api('/api/projects/1/cycles', 'POST', { name: 'BDD', caseIds: [3] });
const execs = (await api(`/api/cycles/${cyc.id}`)).executions;
check('running it creates one run per example row, with the values filled in', execs.length === 2 && (await api(`/api/executions/${execs[1].id}`)).steps[1].action === 'When the customer applies the code "VIP20"');

// ---- list status filter
await setValue('#status-filter', 'Deprecated', 'change'); await sleep(300);
check('the status filter narrows the list', (await count('#rows tr[data-id]')) === 0 && (await text('#rows')).includes('No test cases here'));
await setValue('#status-filter', 'Approved', 'change'); await sleep(300);
check('and Approved brings the approved ones back', (await count('#rows tr[data-id]')) >= 3);
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|502)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
