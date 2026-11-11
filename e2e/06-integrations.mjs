// Stage 2 UI: integrations page and "Send to GitHub" on a bug, against a local fake GitHub.
import http from 'node:http';
import { connect } from './uilib.mjs';

const TOKEN = 'ghp_ui_token_123';
const seen = [];
const gh = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
    if (req.method === 'GET' && req.url === '/repos/acme/shop') return send(200, { full_name: 'acme/shop' });
    if (req.method === 'POST' && req.url === '/repos/acme/shop/issues') return send(201, { number: 7, html_url: 'https://github.com/acme/shop/issues/7' });
    send(404, { message: 'Not Found' });
  });
});
await new Promise((r) => gh.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${gh.address().port}`;

const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, shot } = t;
await t.setup();

await go('#/integrations');
check('integrations page has both cards, nothing connected yet', (await count('[data-card]')) === 2 && (await text('[data-card=github] .int-head')).includes('Not set up'));
const fill = async (kind, values) => { for (const [f, v] of Object.entries(values)) await setValue(`[data-card=${kind}] [data-f=${f}]`, v); };
await fill('github', { owner: 'acme', repo: 'shop', labels: 'bug, ui-found', base: mockUrl, token: 'wrong-token' });
await click('[data-card=github] [data-act=test]'); await sleep(900);
check('wrong token shows the upstream reason, not the token', (await text('[data-msg=github]')).includes('Bad credentials') && !(await text('[data-msg=github]')).includes('wrong-token'), await text('[data-msg=github]'));
await setValue('[data-card=github] [data-f=token]', TOKEN);
await click('[data-card=github] [data-act=test]'); await sleep(900);
check('good token reports the repository', (await text('[data-msg=github]')) === 'Connected to acme/shop');
await click('[data-card=github] [data-act=save]'); await sleep(1000);
check('saving marks it connected', (await text('[data-card=github] .int-head')).includes('Connected'));
check('token field is blank but says it is saved', (await js(`document.querySelector('[data-card=github] [data-f=token]').value`)) === '' && (await js(`document.querySelector('[data-card=github] [data-f=token]').placeholder`)).includes('Saved'));
check('settings were kept', (await js(`document.querySelector('[data-card=github] [data-f=repo]').value`)) === 'shop');
check('Remove button appears', await exists('[data-card=github] [data-act=remove]'));
await click('[data-card=jira] [data-act=save]'); await sleep(500);
check('invalid Jira settings show an inline error', (await text('[data-msg=jira]')).length > 5 , await text('[data-msg=jira]'));
await shot('s2-integrations');

// a bug with a screenshot
const ex = await api('/api/executions/2');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
await api(`/api/step-results/${ex.steps[1].id}`, 'PUT', { status: 'Fail', actual: 'Badge is 0' });
await api(`/api/step-results/${ex.steps[1].id}/attachments`, 'POST', { filename: 'a.png', mime: 'image/png', data: png });
const bug = await api(`/api/step-results/${ex.steps[1].id}/bug`, 'POST', { title: 'Badge not updated' });
await go(`#/bugs/${bug.id}`);
check('bug page offers Send to GitHub only', (await count('[data-act=push]')) === 1 && (await text('[data-act=push]')).includes('GitHub'));
await setValue('#b-title', 'Badge not updated (edited before sending)');
await click('[data-act=push]'); await sleep(1200);
check('toast links to the new issue', (await js(`document.querySelector('#toast').innerHTML`)).includes('https://github.com/acme/shop/issues/7'));
check('issue chip replaces the button', (await text('.links')).includes('GitHub #7') && !(await exists('[data-act=push]')));
check('chip opens safely in a new tab', await js(`(() => { const a = document.querySelector('.links a'); return a.target === '_blank' && a.rel.includes('noopener') && a.href.startsWith('https://github.com/'); })()`));
const issue = JSON.parse(seen.find((r) => r.method === 'POST').body);
check('unsaved edits were saved first and sent', issue.title === 'Badge not updated (edited before sending)', issue.title);
await shot('s2-bug');

await go('#/integrations');
await js(`window.confirm = () => true`);
await click('[data-card=github] [data-act=remove]'); await sleep(900);
check('removing disconnects', (await text('[data-card=github] .int-head')).includes('Not set up'));
await go(`#/bugs/${bug.id}`);
check('the link on the bug survives removal', (await text('.links')).includes('GitHub #7'));
const unexpected = t.errors.filter((e) => !/status of (401|403|400|502)/.test(e));
check('no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
gh.close();
process.exit(t.finish() ? 1 : 0);
