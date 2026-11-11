// Stage 7 UI: requirement links on a case, search by requirement, coverage section on Reports.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, field, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
await api('/api/projects/1/integrations/jira', 'PUT', { config: { base: 'http://127.0.0.1:9/jira', email: 'a@b.co', projectKey: 'PROJ' }, token: 'tok' });

await go('#/cases/1');
check('requirements card starts empty', (await text('#links')).includes('Not linked to any requirement yet'));
await setValue('#l-ref', 'proj-101'); await setValue('#l-title', 'Customers can sign in');
await click('[data-act=add-link]'); await sleep(200);
check('adding shows a chip and clears the inputs', (await text('#links')).includes('proj-101') && (await text('#links')).includes('Customers can sign in') && (await js(`document.querySelector('#l-ref').value`)) === '');
await setValue('#l-ref', 'PROJ-101'); await click('[data-act=add-link]'); await sleep(150);
check('same key (any case) is not added twice', (await count('#links .chip')) === 1);
await setValue('#l-ref', 'WIKI-Login'); await setValue('#l-url', 'https://wiki.example.com/login');
await js(`document.querySelector('#l-ref').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`); await sleep(200);
check('Enter adds the link too', (await count('#links .chip')) === 2);
await setValue('#l-ref', 'TEMP-1'); await click('[data-act=add-link]'); await sleep(100);
await js(`document.querySelector('#links [data-act=del-link][data-i="2"]').click()`); await sleep(150);
check('a link can be removed before saving', (await count('#links .chip')) === 2);
await click('[data-act=save]'); await sleep(900);
const saved = await api('/api/cases/1');
check('saved with derived and explicit addresses', saved.links.length === 2 && saved.links[0].href === 'http://127.0.0.1:9/jira/browse/PROJ-101' && saved.links[1].href === 'https://wiki.example.com/login', JSON.stringify(saved.links));
await go('#/cases/1');
check('chips link out safely after reload', await js(`(() => { const a = [...document.querySelectorAll('#links a')]; return a.length === 2 && a.every(x => x.target === '_blank' && x.rel.includes('noopener')) && a[0].href.endsWith('/browse/PROJ-101'); })()`));
await shot('s7-editor');

// list search by requirement
await go('#/cases');
await setValue('#q', 'proj-101'); await sleep(250);
check('searching a requirement key finds its test case', (await count('#rows tr[data-id]')) === 1 && (await text('#rows')).includes('DEMO-T1'));
await setValue('#q', '');

// coverage report: T2 linked + passed, T3 linked + failed (same requirement as T1)
await api('/api/cases/2', 'PUT', { links: [{ ref: 'PROJ-102', title: 'Cart works' }] });
await api('/api/cases/3', 'PUT', { links: [{ ref: 'PROJ-101' }, { ref: 'PROJ-103' }] });
const cyc = (await api('/api/cycles/1')).executions;
for (const s of (await api(`/api/executions/${cyc[1].id}`)).steps) await api(`/api/step-results/${s.id}`, 'PUT', { status: 'Pass' });
await api(`/api/step-results/${(await api(`/api/executions/${cyc[2].id}`)).steps[0].id}`, 'PUT', { status: 'Fail' });
await api('/api/projects/1/cases', 'POST', { title: 'Unlinked case' });
await go('#/reports');
const sec = await js(`[...document.querySelectorAll('h2')].find(h => h.textContent === 'Requirement coverage').closest('section').innerText`);
check('summary counts requirements by coverage', sec.includes('4 requirements') && sec.includes('1 passing') && sec.includes('2 failing') && sec.includes('1 not run') && sec.includes('1 test case not linked'), sec.replace(/\n/g, ' ').slice(0, 260));
check('table rows name each requirement with a text status', sec.includes('proj-101') && sec.includes('Failing') && sec.includes('Passing') && sec.includes('PROJ-102'));
check('cases show their last result next to the key', sec.includes('DEMO-T2') && sec.includes('Pass') && sec.includes('DEMO-T3') && sec.includes('Fail'));
check('requirement keys link out', await js(`[...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent === 'Requirement coverage').querySelectorAll('table a[target=_blank]').length >= 1`));
check('uncovered cases are listed on demand', sec.includes('Show the 1 test case without a requirement'));
await js(`[...document.querySelectorAll('details')].find(d => d.textContent.includes('without a requirement')).querySelector('summary').click()`); await sleep(150);
check('and the list names the case', await js(`[...document.querySelectorAll('details')].find(d => d.textContent.includes('without a requirement')).innerText.includes('Unlinked case')`));
await shot('s7-coverage');
await js(`window.__dl = []; window.download = (u) => window.__dl.push(u)`);
await js(`document.querySelector('[data-act=export-trace]').click()`); await sleep(300);
await js(`document.querySelector('#dlg form').elements.format.value = 'csv'`); await submit();
check('export URL', (await js(`window.__dl[0]`)) === '/api/projects/1/traceability/export?format=csv');

// viewer cannot add links
await api('/api/users', 'POST', { username: 'vic', password: 'vic password 12', role: 'viewer' });
await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(600);
await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = 'vic'; f.password.value = 'vic password 12'; f.requestSubmit(); })()`); await sleep(1200);
await go('#/cases/1');
check('viewer sees links but no add or remove controls', (await count('#links .chip')) === 2 && !(await visible('[data-act=add-link]')) && !(await visible('#links .x')));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
