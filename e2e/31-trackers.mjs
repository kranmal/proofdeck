// Linear, Azure DevOps and GitLab cards on the Integrations page, using a tiny fake GitLab.
import http from 'node:http';
import { connect } from './uilib.mjs';
const TOKEN = 'glpat_e2e';
const issues = {}; let next = 3;
const gl = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['private-token'] !== TOKEN) return send(401, { message: '401 Unauthorized' });
    if (req.method === 'GET' && req.url === '/api/v4/projects/acme%2Fshop') return send(200, { path_with_namespace: 'acme/shop' });
    if (req.method === 'POST' && req.url === '/api/v4/projects/acme%2Fshop/uploads') return send(201, { markdown: '![s](/uploads/x/s.png)' });
    if (req.method === 'POST' && req.url === '/api/v4/projects/acme%2Fshop/issues') { const iid = next++; issues[iid] = JSON.parse(b); return send(201, { iid, web_url: `https://gitlab.example/-/issues/${iid}` }); }
    send(404, { message: 'nope' });
  });
});
await new Promise((r) => gl.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${gl.address().port}`;

const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
const type = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);

await go('#/integrations'); await sleep(700);
check('Linear, Azure DevOps and GitLab cards are on the page', (await count('[data-card=linear]')) === 1 && (await count('[data-card=azure]')) === 1 && (await count('[data-card=gitlab]')) === 1);
await type('[data-card=gitlab] [data-f=base]', url); await type('[data-card=gitlab] [data-f=project]', 'acme/shop'); await type('[data-card=gitlab] [data-f=token]', 'wrong');
await click('[data-card=gitlab] [data-act=test]'); await sleep(900);
check('a wrong token is explained without echoing it', (await text('[data-msg=gitlab]')).includes('GitLab said') && !(await text('[data-msg=gitlab]')).includes('wrong'), await text('[data-msg=gitlab]'));
await type('[data-card=gitlab] [data-f=token]', TOKEN);
await click('[data-card=gitlab] [data-act=test]'); await sleep(900);
check('the right token connects', (await text('[data-msg=gitlab]')).includes('Connected to acme/shop'), await text('[data-msg=gitlab]'));
await click('[data-card=gitlab] [data-act=save]'); await sleep(1200);
check('saving marks it connected', (await text('[data-card=gitlab]')).includes('Connected') && (await api('/api/projects/1/integrations')).some((i) => i.kind === 'gitlab'));
await click('[data-card=gitlab] [data-act=webhook]'); await sleep(700);
const hookText = await text('[data-hook=gitlab]');
check('GitLab webhook box shows the address, secret token and Issues events', hookText.includes('/api/webhooks/gitlab/1') && hookText.includes('Secret token') && hookText.includes('Issues events'), hookText);
check('the secret is shown for copying', (await js(`document.querySelector('[data-hook=gitlab] input[readonly]').value.length`)) >= 30);

// send a bug there from the bug page
await api('/api/projects/1/bugs', 'POST', { title: 'Goes to GitLab', actual: 'x' });
const bug = (await api('/api/projects/1/bugs')).find((x) => x.title === 'Goes to GitLab');
await go(`#/bugs/${bug.id}`); await sleep(800);
check('the bug page offers Send to GitLab', (await text('#view')).includes('GitLab'));
await js(`document.querySelector('[data-act=push][data-kind=gitlab]').click()`); await sleep(1500);
check('it is sent and linked', (await api(`/api/bugs/${bug.id}`)).links.some((l) => l.kind === 'gitlab' && l.external_key.startsWith('#')) && Object.values(issues).some((i) => i.title === 'Goes to GitLab'));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404|429|502)/.test(e)).length === 0, t.errors.join(' | '));
gl.close();
process.exit(t.finish() ? 1 : 0);
