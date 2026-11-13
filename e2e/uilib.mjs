// Shared CDP helpers for headless-browser UI checks.
import fs from 'node:fs';

export async function connect({ app = 'http://127.0.0.1:4791', out = '.', port = 9333 } = {}) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let seq = 0; const pending = new Map(); const errors = []; let ready = false;
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (!ready) return;
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    // A live-update stream cut because a test server was stopped is expected, not a bug.
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_REFUSED/.test(`${d.params.entry.text}`) ) errors.push(`${d.params.entry.text} ${d.params.entry.url || ''}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result.result.value;
  };
  let pass = 0, failed = 0;
  const check = (label, ok, extra = '') => { ok ? pass++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  -> ' + extra : ''}`); };
  const t = {
    app, send, sleep, js, check, errors, ws,
    shot: async (name) => fs.writeFileSync(`${out}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')),
    go: async (hash) => { await js(`location.hash = ${JSON.stringify(hash)}`); await sleep(600); },
    open: async (path = '/') => { await send('Page.navigate', { url: app + path }); await sleep(900); },
    api: (path, method = 'GET', body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: {'Content-Type':'application/json'}${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ''} }).then(async r => { const t = await r.text(); try { return JSON.parse(t) } catch { return { status: r.status, text: t } } })`),
    click: (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`),
    text: (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`),
    count: (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
    exists: (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`),
    visible: (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none' && !e.hidden && e.getBoundingClientRect().width > 0; })()`),
    setValue: (sel, v, ev = 'input') => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(${JSON.stringify(ev)}, { bubbles: true })); })()`),
    submit: async (sel = '#dlg form') => { await js(`document.querySelector(${JSON.stringify(sel)}).requestSubmit()`); await sleep(800); },
    field: (name, v) => js(`document.querySelector('#dlg form').elements[${JSON.stringify(name)}].value = ${JSON.stringify(v)}`),
    // Create the first admin through the page (so the browser holds the session cookie) and reload.
    setup: async (username = 'admin', password = 'correct horse battery', name = 'Ada Admin') => {
      await t.open('/');
      await js(`fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)}, display_name: ${JSON.stringify(name)} }) }).then(r => r.status)`);
      await t.open('/');
    },
    finish: () => { ws.close(); console.log(`\n${pass} passed, ${failed} failed`); return failed; },
    // Sign in from outside the page (Node side), returns a cookie header for API calls.
    nodeLogin: async (username, password) => {
      const r = await fetch(app + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      return r.headers.getSetCookie()[0].split(';')[0];
    },
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await sleep(500); ready = true; // Log.enable replays old entries; skip them
  return t;
}
