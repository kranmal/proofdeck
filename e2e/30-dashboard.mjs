// Overview: "Waiting for you" and the trend tables; weekly email switch in the account dialog.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, submit, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
const me = (await api('/api/auth/me')).user;
const cyc = (await api('/api/projects/1/cycles')).find((c) => !c.adhoc);
const runs = (await api(`/api/cycles/${cyc.id}`)).executions;
await api(`/api/executions/${runs[0].id}`, 'PUT', { assignee_id: me.id });
await api(`/api/executions/${runs[1].id}`, 'PUT', { assignee_id: me.id });
await api(`/api/executions/${runs[1].id}`, 'PUT', { status: 'Pass' });
await api(`/api/executions/${runs[2].id}`, 'PUT', { status: 'Fail' });
await api('/api/projects/1/bugs', 'POST', { title: 'Mine to fix', actual: 'x', severity: 'Major' });
const b = (await api('/api/projects/1/bugs'))[0];
await api(`/api/bugs/${b.id}`, 'PUT', { assignee_id: me.id });

await go('#/'); await sleep(900);
check('Overview shows a Waiting for you card with my open run and bug', (await text('#mywork')).includes(runs[0].case_key) && (await text('#mywork')).includes('Mine to fix'), await text('#mywork'));
check('my last 14 days lists today with pass and fail counts', (await text('#view')).includes('Your last 14 days') && (await count('#view .bar')) >= 2);
check('the team table has eight weekly rows', (await js(`[...document.querySelectorAll('#view h2')].find((h) => h.textContent === 'Team, by week').parentElement.querySelectorAll('tbody tr').length`)) === 8);
await click('#me'); await sleep(400);
check('the account dialog has the weekly summary switch', await js(`!!document.querySelector('dialog [name=weekly_report]')`));
await js(`document.querySelector('dialog [name=weekly_report]').click()`);
await submit(); await sleep(800);
check('it is saved', (await api('/api/auth/me')).user.weekly_report === true);
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404|429)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
