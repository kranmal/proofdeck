// Time zone in the account dialog.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, click, text, count, submit, field } = t;
await send_focus();
async function send_focus() { await t.send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
await t.setup();
await click('#me'); await sleep(400);
check('account dialog has a time zone picker with many zones', (await count('select[name=timezone] option')) > 100);
await js(`(() => { const s = document.querySelector('[name=timezone]'); s.value = 'Europe/Lisbon'; })()`);
await submit(); await sleep(600);
check('the zone is saved', (await api('/api/auth/me')).user.timezone === 'Europe/Lisbon');
await click('#me'); await sleep(400);
check('and shown again when reopened', (await js(`document.querySelector('[name=timezone]').value`)) === 'Europe/Lisbon');
await js(`document.querySelector('[data-act=browser-tz]').click()`);
const want = await js(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
check('"Use my browser\'s time zone" selects it', (await js(`document.querySelector('[name=timezone]').value`)) === want, want);
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
