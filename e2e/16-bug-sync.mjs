// Two-way bug sync in the UI, against a stateful fake GitHub.
import http from 'node:http';
import { connect } from './uilib.mjs';

const TOKEN = 'ghp_e2e_sync';
const gh = { issues: {}, next: 7, patches: [], missing: false };
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
    let m;
    if (req.method === 'GET' && req.url === '/repos/acme/shop') return send(200, { full_name: 'acme/shop' });
    if (req.method === 'POST' && req.url === '/repos/acme/shop/issues') { const n = gh.next++; gh.issues[n] = { state: 'open' }; return send(201, { number: n, html_url: `https://github.com/acme/shop/issues/${n}` }); }
    if ((m = /^\/repos\/acme\/shop\/issues\/(\d+)$/.exec(req.url))) {
      const n = Number(m[1]);
      if (gh.missing || !gh.issues[n]) return send(404, { message: 'Not Found' });
      if (req.method === 'GET') return send(200, gh.issues[n]);
      if (req.method === 'PATCH') { const body = JSON.parse(b); gh.patches.push(body); Object.assign(gh.issues[n], body); return send(200, gh.issues[n]); }
    }
    send(404, { message: 'Not Found' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mock = `http://127.0.0.1:${server.address().port}`;

const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, field, submit, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

await go('#/integrations');
const set = (f, v) => setValue(`[data-card=github] [data-f=${f}]`, v);
await set('owner', 'acme'); await set('repo', 'shop'); await set('base', mock); await set('token', TOKEN);
check('sync defaults: pull on, push off', await js(`document.querySelector('[data-card=github] [data-s=pull]').checked`) && !(await js(`document.querySelector('[data-card=github] [data-s=push]').checked`)));
await js(`document.querySelector('[data-card=github] [data-s=push]').click()`);
await setValue('[data-card=github] [data-s=onClose]', 'Closed', 'change');
await click('[data-card=github] [data-act=save]'); await sleep(1000);
check('options persist after saving', await js(`document.querySelector('[data-card=github] [data-s=push]').checked`) && (await js(`document.querySelector('[data-card=github] [data-s=onClose]').value`)) === 'Closed');
check('webhook and sync-all controls appear once connected', await exists('[data-card=github] [data-act=webhook]') && await exists('[data-card=github] [data-act=syncall]'));

// webhook details
await js(`window.confirm = () => true`);
await click('[data-card=github] [data-act=webhook]'); await sleep(600);
const hook = await text('[data-hook=github]');
check('webhook box shows the URL, content type and event to choose', hook.includes('/api/webhooks/github/1') && hook.includes('application/json') && hook.includes('Issues'));
const s1 = await js(`document.querySelector('[data-hook=github] input').value`);
check('a secret is shown', s1.length >= 30);
await click('[data-hook=github] [data-act=webhook-new]'); await sleep(600);
check('“New secret” replaces it', (await js(`document.querySelector('[data-hook=github] input').value`)) !== s1);

// a bug pushed to GitHub
const bug = await api('/api/projects/1/bugs', 'POST', { title: 'Totals wrong', actual: '£0' });
await api(`/api/bugs/${bug.id}/push`, 'POST', { kind: 'github' });
await go(`#/bugs/${bug.id}`);
check('the link chip shows the issue state, and Sync now is offered', (await text('.links')).includes('GitHub #7 · open') && await visible('[data-act=sync]'));

gh.issues[7].state = 'closed';
await click('[data-act=sync]'); await sleep(1200);
check('Sync now moves the bug to the configured status and explains it', (await text('#toast')).includes('is closed') && (await text('#toast')).includes('bug is now Closed'), await text('#toast'));
check('the page shows the new status, the chip and the system comment', (await js(`document.querySelector('#b-status').value`)) === 'Closed' && (await text('.links')).includes('closed') && (await text('.comment')).includes('because #7 is now “closed” in GitHub'));
await shot('s16-bug-sync');
gh.issues[7].state = 'open';
await click('[data-act=sync]'); await sleep(1000);
check('reopening it brings the bug back to Open', (await js(`document.querySelector('#b-status').value`)) === 'Open');
await click('[data-act=sync]'); await sleep(800);
check('nothing new says so', (await text('#toast')).includes('Already up to date'));

// push: change the status here, the issue follows
await setValue('#b-status', 'Resolved', 'change');
await click('[data-act=save]'); await sleep(1500);
check('changing the status in Proofdeck closes the GitHub issue', gh.issues[7].state === 'closed' && gh.patches.at(-1).state === 'closed', JSON.stringify(gh.patches));
await sleep(500);
await js('router()'); await sleep(800);
check('and the chip reflects it after the push', (await text('.links')).includes('closed'));

// problems are shown
gh.missing = true;
await click('[data-act=sync]'); await sleep(1000);
check('a failure is explained on the bug', (await text('#view')).includes('Could not sync with GitHub #7') && (await text('#view')).includes('Not Found'), (await text('#toast')));
gh.missing = false;
await click('[data-act=sync]'); await sleep(800);
check('and goes away once it works', !(await text('#view')).includes('Could not sync with GitHub'));
await go('#/integrations');
await click('[data-card=github] [data-act=syncall]'); await sleep(1200);
check('“Sync all bugs now” reports what it did', (await text('#toast')).includes('Checked 1 bug'), await text('#toast'));

// viewers cannot sync
await api('/api/users', 'POST', { username: 'vic', password: 'vic password 12', role: 'viewer' });
await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(600);
await js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = 'vic'; f.password.value = 'vic password 12'; f.requestSubmit(); })()`); await sleep(1200);
await go(`#/bugs/${bug.id}`);
check('viewers see the link but no Sync button', (await text('.links')).includes('GitHub #7') && !(await visible('[data-act=sync]')));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|502)/.test(e)).length === 0, t.errors.join(' | '));
server.close();
process.exit(t.finish() ? 1 : 0);
