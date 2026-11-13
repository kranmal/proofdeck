// Webhooks admin page: add, test, see the result, edit, delete.
import http from 'node:http';
import { connect } from './uilib.mjs';
const got = [];
const sink = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { got.push(b); res.end('ok'); }); });
await new Promise((r) => sink.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${sink.address().port}/services/SECRET`;

const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, field, submit, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
await js(`window.confirm = () => true`);

check('Webhooks is in the admin nav', await js(`!document.querySelector('#nav a[data-nav=webhooks]').hidden`));
await go('#/webhooks'); await sleep(500);
check('starts empty', (await text('#view')).includes('No webhooks yet'));
await click('[data-act=add]'); await sleep(400);
await field('name', '#qa-alerts'); await field('url', url);
await submit(); await sleep(900);
check('the webhook is listed with its host but not the secret address', (await text('tbody')).includes('#qa-alerts') && (await text('tbody')).includes('127.0.0.1') && !(await text('tbody')).includes('SECRET'));
await click('[data-act=test]'); await sleep(2800);
check('the test message arrived at the receiver', got.length === 1 && JSON.parse(got[0]).text.includes('Test from Proofdeck'), got.join('|'));
await go('#/bugs'); await sleep(300); await go('#/webhooks'); await sleep(600);
check('the page shows it as delivered', (await text('tbody')).includes('Delivered'));
// a real event
await api('/api/projects/1/bugs', 'POST', { title: 'Seen on Slack', actual: 'x' });
await sleep(3000);
check('a new bug is posted (bug.created is on by default)', got.length === 2 && JSON.parse(got[1]).text.includes('Seen on Slack'));
// edit: pause it
await click('[data-act=edit]'); await sleep(400);
await js(`document.querySelector('dialog input[name=active]').click()`);
await submit(); await sleep(800);
check('paused webhooks are marked', (await text('tbody')).includes('Paused'));
await click('[data-act=del]'); await sleep(800);
check('delete removes it', (await text('#view')).includes('No webhooks yet'));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404)/.test(e)).length === 0, t.errors.join(' | '));
sink.close();
process.exit(t.finish() ? 1 : 0);
