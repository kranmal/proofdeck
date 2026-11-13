// Phone-sized screen: the test player shows one step at a time with thumb-sized buttons; the desktop layout is untouched.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, text, count, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

// a case with four steps in a cycle
const steps = [1, 2, 3, 4].map((n) => ({ action: `Do thing ${n}`, expected: `Thing ${n} happened` }));
const c = await api('/api/projects/1/cases', 'POST', { title: 'Phone case', steps });
const cyc = await api('/api/projects/1/cycles', 'POST', { name: 'Phone cycle' });
await api(`/api/cycles/${cyc.id}/cases`, 'POST', { caseIds: [c.id] });
const exe = (await api(`/api/cycles/${cyc.id}`)).executions[0];

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await go(`#/run/${exe.id}`); await sleep(1000);
const visible = `[...document.querySelectorAll('.step')].filter((s) => s.offsetParent !== null)`;
check('only the current step is on screen', (await js(`${visible}.length`)) === 1 && (await js(`${visible}[0].dataset.step === document.querySelector('.step.active').dataset.step`)));
check('a strip of four numbered steps is shown', (await count('.stepstrip button')) === 4 && await js(`getComputedStyle(document.querySelector('.stepstrip')).display === 'flex'`));
check('the page does not scroll sideways', await js(`document.documentElement.scrollWidth <= window.innerWidth`), await js(`document.documentElement.scrollWidth + ' > ' + window.innerWidth`));
check('Pass / Fail / Blocked sit at the bottom edge', await js(`(() => { const r = document.querySelector('.step.active > footer').getBoundingClientRect(); return Math.round(r.bottom) === window.innerHeight && r.width >= window.innerWidth - 1; })()`));
check('the buttons are thumb-sized', await js(`[...document.querySelectorAll('.step.active > footer .btn')].every((b) => b.getBoundingClientRect().height >= 44)`));
check('there is a camera button', await js(`!!document.querySelector('.step.active input[capture=environment]') && getComputedStyle(document.querySelector('.step.active .cam')).display !== 'none'`));
check('text fields are 16px so the phone does not zoom', await js(`parseFloat(getComputedStyle(document.querySelector('.step.active [data-actual]')).fontSize) >= 16`));
check('the project picker is wide enough to read', await js(`document.querySelector('#project').getBoundingClientRect().width >= 180`), await js(`document.querySelector('#project').getBoundingClientRect().width`));
check('the menu is one scrolling row', await js(`document.querySelector('#nav').getBoundingClientRect().height < 80`), await js(`document.querySelector('#nav').getBoundingClientRect().height`));

// tap Pass: the result is saved and the next step comes up
await js(`document.querySelector('.step.active [data-v=Pass]').click()`); await sleep(900);
const after = await api(`/api/executions/${exe.id}`);
check('Pass was saved on step 1', after.steps[0].status === 'Pass');
check('step 2 is now the one shown', (await js(`document.querySelector('.step.active').dataset.step`)) == after.steps[1].id && (await js(`${visible}.length`)) === 1);
check('the strip marks step 1 as passed and step 2 as current', await js(`(() => { const b = document.querySelectorAll('.stepstrip button'); return b[0].classList.contains('pass') && b[1].classList.contains('on') && b[1].getAttribute('aria-current') === 'step'; })()`));

// jump back with the strip, then fail a step
await js(`document.querySelectorAll('.stepstrip button')[0].click()`); await sleep(300);
check('tapping a number shows that step', (await js(`document.querySelector('.step.active').dataset.step`)) == after.steps[0].id && (await js(`${visible}.length`)) === 1);
await js(`document.querySelectorAll('.stepstrip button')[2].click()`); await sleep(300);
await js(`document.querySelector('.step.active [data-v=Fail]').click()`); await sleep(900);
check('Fail offers Create bug in the bottom bar', await js(`!!document.querySelector('.step.active > footer [data-act=bug]')`));
check('step 3 is failed and stays on screen', (await api(`/api/executions/${exe.id}`)).steps[2].status === 'Fail' && (await js(`document.querySelector('.step.active').dataset.step`)) == after.steps[2].id);
check('the keyboard shortcut hint is hidden', await js(`getComputedStyle(document.querySelector('.keys')).display === 'none'`));

// the other pages do not spill sideways either
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
for (const h of ['#/', '#/cases', '#/cases/' + c.id, '#/cycles', `#/cycles/${cyc.id}`, '#/bugs', '#/reports', '#/notifications', '#/trash']) {
  await go(h); await sleep(700);
  check(`${h} fits the screen`, await js(`document.documentElement.scrollWidth <= window.innerWidth`), await js(`document.documentElement.scrollWidth + ' > ' + window.innerWidth`));
}
await go(`#/run/${exe.id}`); await sleep(700);
await t.shot('mobile-run');

// back to a desktop-sized window
await send('Emulation.clearDeviceMetricsOverride');
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });
await go(`#/run/${exe.id}`); await sleep(900);
check('desktop shows every step and no strip', (await js(`${visible}.length`)) === 4 && await js(`getComputedStyle(document.querySelector('.stepstrip')).display === 'none'`));
check('desktop has no camera button', await js(`getComputedStyle(document.querySelector('.step .cam')).display === 'none'`));
check('desktop buttons stay in the card, not fixed', await js(`getComputedStyle(document.querySelector('.step > footer')).position !== 'fixed'`));

check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404|429)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
