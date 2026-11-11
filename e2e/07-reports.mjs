// Stage 3 UI: the Reports page — chart geometry, textures, tooltips, keyboard, table view, dark mode, phone width.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, exists, visible, setValue, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

async function runCycle(name, build, plan) {
  const c = await api('/api/projects/1/cycles', 'POST', { name, build, environment: 'Staging', caseIds: [1, 2, 3] });
  const ex = (await api(`/api/cycles/${c.id}`)).executions;
  for (const [i, st] of plan.entries()) {
    if (!st) continue;
    const steps = (await api(`/api/executions/${ex[i].id}`)).steps;
    for (const s of st === 'Pass' ? steps : steps.slice(0, 1)) await api(`/api/step-results/${s.id}`, 'PUT', { status: st, actual: st === 'Fail' ? 'boom' : '' });
  }
}
await runCycle('Sprint 1', '1.0.1', ['Pass', 'Fail', null]);      // 1 pass, 1 fail, 1 not run
await runCycle('Sprint 2', '1.0.2', ['Pass', 'Pass', 'Pass']);    // 3 pass
await runCycle('Sprint 3', '1.0.3', ['Blocked', null, null]);     // 1 blocked, 2 not run

await go('#/reports');
check('reports page opens with 4 tiles', (await count('.tile')) === 4);
check('one bar group per planned cycle (seed cycle + 3)', (await count('#trend .bar')) === 4);
check('legend names every status with an icon', (await js(`document.querySelector('.legend-row').querySelectorAll('.lg').length`)) === 4 && (await js(`document.querySelector('.legend-row').querySelectorAll('.lg svg').length`)) === 4);

// geometry: Sprint 1 has 1 pass / 1 fail / 1 not run => three equal segments (minus the 2px gaps)
const geo = await js(`(() => { const g = [...document.querySelectorAll('#trend .bar')].find(b => b.getAttribute('aria-label').startsWith('DEMO-C2'));
  const h = (cls) => { const e = g.querySelector('.seg-' + cls); return e ? e.getBBox().height : 0; };
  const ys = (cls) => { const e = g.querySelector('.seg-' + cls); return e ? e.getBBox().y : null; };
  return { pass: h('pass'), fail: h('fail'), rest: h('rest'), yp: ys('pass'), yf: ys('fail'), yr: ys('rest'), label: g.getAttribute('aria-label') }; })()`);
check('segments are proportional to counts (±3px incl. gaps)', Math.abs(geo.pass - geo.fail) < 3.5 && Math.abs(geo.fail - geo.rest) < 3.5 && geo.pass > 20, JSON.stringify(geo));
check('stack order bottom→top: pass, fail, not run', geo.yp > geo.yf && geo.yf > geo.yr);
check('segments have a 2px gap', Math.abs((geo.yp - (geo.yf + geo.fail)) - 2) < 0.6, String(geo.yp - (geo.yf + geo.fail)));
check('aria-label states the numbers', geo.label.includes('1 passed, 1 failed, 0 blocked, 1 not run'), geo.label);
check('fail and blocked segments carry textures', (await count('#trend .seg-fail + .tx')) >= 1 && (await count('#trend .seg-blocked + .tx')) >= 1);
const tc = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).textContent`);
const sprint2 = await tc('#trend .bar[aria-label^="DEMO-C3"] .pct');
check('direct label shows pass rate above the bar', sprint2.trim() === '100%', sprint2);
check('pass rate ignores not-run tests (Sprint 1: 1 of 2 decided = 50%)', (await tc('#trend .bar[aria-label^="DEMO-C2"] .pct')).trim() === '50%');

// hover
await js(`(() => { const hit = document.querySelector('#trend .bar[aria-label^="DEMO-C2"] .hit'); const r = hit.getBoundingClientRect();
  hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 10, clientY: r.top + 40 })); })()`); await sleep(200);
const tip = await text('#trend .tip');
check('hover shows a tooltip with counts and pass rate', await visible('#trend .tip') && tip.includes('Sprint 1') && tip.includes('Pass') && tip.includes('50%'), tip.replace(/\n/g, ' | '));
check('tooltip stays inside the chart', await js(`(() => { const t = document.querySelector('#trend .tip').getBoundingClientRect(), w = document.querySelector('#trend').getBoundingClientRect(); return t.left >= w.left - 1 && t.right <= w.right + 1; })()`));
await js(`document.querySelector('#trend svg').dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))`); await sleep(100);
check('leaving the chart hides it', !(await visible('#trend .tip')));
// keyboard
await js(`document.querySelector('#trend .bar[aria-label^="DEMO-C4"]').focus()`); await sleep(200);
check('keyboard focus shows the same tooltip', await visible('#trend .tip') && (await text('#trend .tip')).includes('Sprint 3'));
check('bars are focusable', (await js(`[...document.querySelectorAll('#trend .bar')].every(b => b.tabIndex === 0)`)));

// percent mode
await click('[data-mode=percent]'); await sleep(300);
const tops = await js(`[...document.querySelectorAll('#trend .bar')].map(g => { const segs = [...g.querySelectorAll('path.seg')]; return segs.length ? Math.min(...segs.map(s => s.getBBox().y)) : null; }).filter(v => v !== null)`);
check('percent mode: every bar reaches 100%', tops.length >= 3 && tops.every((y) => Math.abs(y - tops[0]) < 5), JSON.stringify(tops.map((y) => Math.round(y))));
check('percent mode: axis shows %', (await js(`[...document.querySelectorAll('#trend .ytick')].some(e => e.textContent.endsWith('%'))`)));
check('toggle state is exposed', (await js(`document.querySelector('[data-mode=percent]').getAttribute('aria-pressed')`)) === 'true');
await click('[data-mode=count]'); await sleep(200);

// table view
await js(`document.querySelector('.tableview summary').click()`); await sleep(200);
check('table view mirrors the chart', (await count('.tableview tbody tr')) === 4 && (await text('.tableview')).includes('Sprint 1'));
check('coverage bar and legend counts present', (await count('.bar.thick i')) >= 2 && (await text('.grid2')).includes('Never run') === false && (await count('.grid2 .legend-row .lg')) === 4);

// range selector
await setValue('#rcycles', '5', 'change'); await sleep(600);
check('cycle-count selector re-renders', (await js(`document.querySelector('#rcycles').value`)) === '5' && (await count('#trend .bar')) === 4);

// tables
check('failing + flaky + bug sections render', (await text('.grid2')).includes('Most failures') && (await text('.grid2')).includes('Flaky test cases'));
check('failing table lists the failing case', (await text('.grid2')).includes('DEMO-T2'));
await shot('s3-reports-light');

// colours: light + dark computed values
const light = await js(`(() => { const c = (sel) => getComputedStyle(document.querySelector(sel)).fill; return { pass: c('#trend .seg-pass'), fail: c('#trend .seg-fail'), blocked: c('#trend .seg-blocked') }; })()`);
check('light palette is the validated one', light.pass === 'rgb(20, 120, 168)' && light.fail === 'rgb(214, 51, 108)' && light.blocked === 'rgb(183, 121, 31)', JSON.stringify(light));
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await sleep(500);
const dark = await js(`(() => { const c = (sel) => getComputedStyle(document.querySelector(sel)).fill; return { pass: c('#trend .seg-pass'), fail: c('#trend .seg-fail'), blocked: c('#trend .seg-blocked') }; })()`);
check('dark palette is the validated one', dark.pass === 'rgb(61, 155, 214)' && dark.fail === 'rgb(229, 85, 127)' && dark.blocked === 'rgb(189, 132, 30)', JSON.stringify(dark));
await shot('s3-reports-dark');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

// export
await js(`window.__dl = []; window.download = (u) => window.__dl.push(u)`);
await click('[data-act=export]'); await sleep(300);
await js(`document.querySelector('#dlg form').elements.format.value = 'csv'`); await t.submit();
check('export dialog builds the trend URL', (await js(`window.__dl[0]`)) === '/api/projects/1/reports/export?format=csv&cycles=5', await js(`window.__dl[0]`));

// narrow screen: chart shrinks, no sideways scroll
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await sleep(600);
const narrow = await js(`({ sw: document.documentElement.scrollWidth, iw: innerWidth, svg: document.querySelector('#trend svg').getBoundingClientRect().width, wrap: document.querySelector('#trend').getBoundingClientRect().width })`);
check('phone: no sideways page scroll and chart fits', narrow.sw <= narrow.iw + 1 && narrow.svg <= narrow.wrap + 1, JSON.stringify(narrow));
await shot('s3-reports-phone');
await send('Emulation.clearDeviceMetricsOverride');
const unexpected = t.errors.filter((e) => !/status of (401|403|400)/.test(e));
check('no console errors', unexpected.length === 0, unexpected.join(' | '));
process.exit(t.finish() ? 1 : 0);
