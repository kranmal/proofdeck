// Password fields have an eye button that toggles between hidden and visible text.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, count, click } = t;
await t.setup();
await t.send('Emulation.setFocusEmulationEnabled', { enabled: true });

await click('#me'); await sleep(500);
const sel = `document.querySelector('input[name=next]')`;
check('the new-password field has an eye button', (await count('.pw input[name=next] + .pw-eye')) === 1);
check('the password starts hidden', await js(`${sel}.type === 'password'`));
await js(`document.querySelector('input[name=next]').nextElementSibling.click()`); await sleep(100);
check('clicking the eye shows the text', await js(`${sel}.type === 'text'`));
check('the button says Hide password and is pressed', await js(`(() => { const b = ${sel}.nextElementSibling; return b.getAttribute('aria-label') === 'Hide password' && b.getAttribute('aria-pressed') === 'true'; })()`));
await js(`${sel}.nextElementSibling.click()`); await sleep(100);
check('clicking again hides it', await js(`${sel}.type === 'password' && ${sel}.nextElementSibling.getAttribute('aria-label') === 'Show password'`));
check('the field keeps focus after the toggle', await js(`document.activeElement === ${sel}`));
check('the eye does not submit the form', await js(`${sel}.nextElementSibling.type === 'button'`));
check('every password field on the page is wrapped exactly once', await js(`[...document.querySelectorAll('input[type=password], .pw input')].every((i) => i.closest('.pw') && i.closest('.pw').querySelectorAll('.pw-eye').length === 1)`));
check('the eye sits inside the field on the right', await js(`(() => { const i = ${sel}.getBoundingClientRect(), b = ${sel}.nextElementSibling.getBoundingClientRect(); return b.right <= i.right + 1 && b.left > i.left + i.width / 2; })()`));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404|429)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
