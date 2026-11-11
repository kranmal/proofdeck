import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
await t.setup();
for (let i = 0; i < 25; i++) await t.api('/api/projects/1/cases', 'POST', { title: 'Filler ' + i });
await t.go('#/cases'); await t.js(`window.scrollTo(0, 700)`); await t.sleep(300);
const r = await t.js(`(() => { const s = document.querySelector('.side').getBoundingClientRect(); return { top: s.top, bottom: s.bottom, vh: innerHeight, scrolled: scrollY, docH: document.documentElement.scrollHeight }; })()`);
t.check('sidebar still spans the viewport after scrolling', Math.abs(r.top) < 1 && Math.abs(r.bottom - r.vh) < 2 && r.scrolled > 100, JSON.stringify(r));
await t.shot('scroll-sidebar');
process.exit(t.finish() ? 1 : 0);
