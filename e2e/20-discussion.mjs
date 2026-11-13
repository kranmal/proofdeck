// Comments and files on a test case and on a run.
import { connect } from './uilib.mjs';
const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, shot, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();

const comment = async (msg) => {
  await js(`(() => { const ta = document.querySelector('#discuss [data-dis-text]'); ta.value = ${JSON.stringify(msg)}; })()`);
  await click('#discuss [data-dis=comment]'); await sleep(700);
};

// ---- test case page: unsaved edits survive a comment
await go('#/cases/1');
await sleep(500);
await js(`(() => { const f = document.querySelector('#f-title'); f.value = 'Edited but not saved'; })()`);
check('case page has a comments card', (await count('#discuss')) === 1 && (await text('#discuss')).includes('No comments yet'));
await comment('First note on the case');
check('the comment is listed with its author', (await text('#discuss')).includes('First note on the case') && (await text('#discuss')).includes('Ada'), await text('#discuss'));
check('typing elsewhere on the page was not lost', await js(`(document.querySelector('#f-title')).value === 'Edited but not saved'`));
await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['2026 log line\\n'], 'case.log', { type: '' }));
  const inp = document.querySelector('#discuss input[data-dis-upload]'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(900);
check('an uploaded file shows as a chip and is stored on the case', (await count('#discuss .filechip')) === 1 && (await api('/api/cases/1')).attachments.length === 1);
await click('#discuss .filechip .x'); await sleep(700);
check('the file can be removed', (await count('#discuss .filechip')) === 0 && (await api('/api/cases/1')).attachments.length === 0);
await click('#discuss [data-dis=del]'); await sleep(700);
check('the comment can be deleted', (await api('/api/cases/1')).comments.length === 0 && (await text('#discuss')).includes('No comments yet'));
await shot('discussion-case');

// ---- run page
await go('#/run/2');
await sleep(500);
check('run page has a comments card', (await count('#discuss')) === 1);
await comment('Run note @nobody');
check('run comment is stored on the execution', (await api('/api/executions/2')).comments.length === 1 && (await text('#discuss')).includes('Run note'));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
