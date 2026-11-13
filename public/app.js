'use strict';
/* Proofdeck frontend — vanilla JS, hash router. All dynamic text goes through esc(). */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
const dlg = $('#dlg');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (s) => String(s || '').toLowerCase().replace(/\s+/g, '-');
const pill = (s) => `<span class="pill ${cls(s)}">${esc(s)}</span>`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtMs = (ms) => (!(ms > 0) ? '' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const firstLine = (s) => String(s || '').split('\n')[0].trim();
const options = (list, cur) => list.map((o) => `<option${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('');

// ---------- icons: inline SVG on a 24px grid, drawn in currentColor so they follow the theme ----------
const ICON_PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  list: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="m9 14 2 2 4-4"/>',
  cycle: '<path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/>',
  bug: '<rect x="8" y="7" width="8" height="12" rx="4"/><path d="M12 11v8M12 7V4M9 4l1.5 2M15 4l-1.5 2M8 11H4M16 11h4M8 16l-3 2M16 16l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  up: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 16v4h16v-4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'folder-plus': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13h7M13 10l3 3-3 3"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="m12 5-7 7 7 7"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.8"/><path d="M17.5 14.2A5.5 5.5 0 0 1 21.5 20"/>',
  logout: '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="m16 8 4 4-4 4M20 12H9"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l3 3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  plan: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  chart: '<path d="M5 20v-7M12 20V5M19 20v-10"/><path d="M3 20h18"/>',
  minus: '<path d="M5 12h14"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;
const withIcon = (name, text) => `${icon(name)}<span>${text}</span>`;

const STATE = { projects: [], pid: null, user: null, users: [] };
// Test case list view state; survives navigating to a case and back.
const CASES_UI = { folder: '', deep: true, term: '', status: '', collapsed: new Set(), sel: new Set() };
const resetCasesUi = () => { Object.assign(CASES_UI, { folder: '', deep: true, term: '', status: '' }); CASES_UI.collapsed.clear(); CASES_UI.sel.clear(); };
let pasteHandler = null;
let keyHandler = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    // Every write is JSON (the server refuses anything else), even when there is nothing to send.
    headers: body !== undefined || (method !== 'GET' && method !== 'DELETE') ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' && method !== 'DELETE' ? '{}' : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { renderAuth(false, 'Your session has ended. Please sign in again.'); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(html, isError, ms) {
  const t = $('#toast');
  t.innerHTML = html;
  t.className = 'show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, ms || (isError ? 6000 : 4000));
}
const fail = (e) => toast(esc(e.message || e), true);
// After a delete: say where it went and offer to bring it back.
const KIND_PATH = { case: 'cases', cycle: 'cycles', bug: 'bugs', execution: 'run' };
const deletedToast = (what, trashId) => {
  if (!trashId) return toast(`${esc(what)} deleted`);
  toast(`${esc(what)} moved to Trash. <button type="button" class="linkbtn" data-undo="${trashId}">Undo</button>`, false, 12000);
};
document.addEventListener('click', async (e) => {
  const u = e.target.closest('[data-undo]');
  if (!u) return;
  try {
    const r = await api('POST', `/api/trash/${u.dataset.undo}/restore`, {});
    toast('Restored');
    const want = `#/${KIND_PATH[r.kind]}/${r.id}`;
    if (location.hash === want) router(); else location.hash = want;
  } catch (err) { fail(err); }
});

function bar(c) {
  const total = c.total || 0;
  const seg = (k, label) => (c[k] ? `<i class="${label}" style="width:${(c[k] / total) * 100}%" title="${esc(label)}: ${c[k]}"></i>` : '');
  return `<div class="bar" role="img" aria-label="${c.pass} passed, ${c.fail} failed, ${c.blocked} blocked of ${total}">
    ${total ? seg('pass', 'pass') + seg('fail', 'fail') + seg('blocked', 'blocked') + seg('in_progress', 'in-progress') : ''}</div>`;
}

function openDialog(html, onSubmit, onOpen) {
  dlg.innerHTML = `<form method="dialog">${html}</form>`;
  const form = $('form', dlg);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try { await onSubmit(new FormData(form)); dlg.close(); }
    catch (err) { fail(err); btn.disabled = false; }
  };
  form.onclick = (e) => { if (e.target.closest('[data-close]')) dlg.close(); };
  dlg.showModal();
  if (onOpen) onOpen(form);
}

const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip', mp4: 'video/mp4', webm: 'video/webm' };
const ACCEPT = Object.keys(EXT_MIME).map((e) => '.' + e).join(',');
const mimeOf = (f) => (f.type && Object.values(EXT_MIME).includes(f.type) ? f.type : EXT_MIME[(f.name.split('.').pop() || '').toLowerCase()] || '');
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ filename: file.name || 'screenshot.png', mime: mimeOf(file) || file.type, data: String(r.result).split(',')[1] });
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}
const imagesFrom = (list) => [...(list || [])].filter((f) => f && f.type && f.type.startsWith('image/'));
// Files chosen or dropped: anything we accept as an attachment. Others are reported, never silently dropped.
const filesFrom = (list) => {
  const all = [...(list || [])].filter(Boolean);
  const ok = all.filter((f) => mimeOf(f));
  if (ok.length < all.length) toast(`${all.length - ok.length} file${all.length - ok.length === 1 ? ' was' : 's were'} skipped: use images, PDF, text, CSV, JSON, ZIP, MP4 or WebM.`, true);
  return ok;
};
const isImage = (a) => /^image\//.test(a.mime);
// One attachment: image thumbnail (with Annotate) or a file chip. `pick` renders a checkbox for the bug dialog.
function attHtml(a, { removable = false, annotate = false, pick = null } = {}) {
  const rm = removable ? `<button type="button" class="x" data-act="rm-shot" data-id="${a.id}" aria-label="Remove ${esc(a.filename)}" title="Remove">${icon('x')}</button>` : '';
  const box = pick ? `<input type="checkbox" name="att" value="${a.id}"${pick.has(a.id) ? '' : ' checked'} aria-label="Include ${esc(a.filename)}">` : '';
  if (isImage(a)) {
    const img = `<img src="/api/attachments/${a.id}?v=${a.size}" alt="${esc(a.filename)}" loading="lazy">`;
    if (pick) return `<label class="thumb pick">${box}${img}</label>`;
    return `<span class="thumb"><a href="/api/attachments/${a.id}" target="_blank" rel="noopener">${img}</a>${annotate ? `<button type="button" class="ann" data-act="annotate" data-id="${a.id}" aria-label="Annotate ${esc(a.filename)}" title="Annotate">${icon('pencil')}</button>` : ''}${rm}</span>`;
  }
  const body = `${icon(a.mime.startsWith('video/') ? 'film' : 'file')}<span class="fn">${esc(a.filename)}</span><small>${fmtSize(a.size)}</small>`;
  if (pick) return `<label class="thumb filechip pick">${box}<span class="file">${body}</span></label>`;
  return `<span class="thumb filechip"><a class="file" href="/api/attachments/${a.id}" ${a.mime.startsWith('video/') ? 'target="_blank" rel="noopener"' : 'download'}>${body}</a>${rm}</span>`;
}
async function uploadImages(url, files) {
  for (const f of files) await api('POST', url, await fileToPayload(f));
}

// Comments and files on a test case or a run. Mounts into an element and keeps its own state, so typing in the
// rest of the page is never lost when a comment is added.
function mountDiscussion(box, type, id, data) {
  if (!box) return;
  const base = `/api/${type === 'case' ? 'cases' : 'executions'}/${id}`;
  let comments = data.comments, atts = data.attachments;
  const paint = () => {
    box.innerHTML = `<h2>Comments and files</h2>
      ${comments.length ? comments.map((c) => `<div class="comment"><div class="cmeta"><b>${esc(c.author || 'Former user')}</b> <span class="muted">${fmtDate(c.created_at)}</span>
        ${c.user_id === STATE.user.id || STATE.user.role === 'admin' ? `<button type="button" class="icon small danger" data-dis="del" data-id="${c.id}" aria-label="Delete comment" title="Delete comment">${icon('trash')}</button>` : ''}</div>
        <p class="pre">${esc(c.body)}</p></div>`).join('') : '<p class="muted">No comments yet. Use @username to notify someone.</p>'}
      <label>Add a comment<textarea data-dis-text rows="3" maxlength="10000"></textarea></label>
      <p><button type="button" class="btn primary small" data-dis="comment">${withIcon('plus', 'Comment')}</button></p>
      <div class="shots large">${atts.map((a) => attHtml(a, { removable: true, annotate: true })).join('')}
        <label class="btn small ghost">${withIcon('image', 'Add file')}<input type="file" accept="${ACCEPT}" multiple hidden data-dis-upload></label></div>`;
  };
  const refresh = async () => {
    const d = await api('GET', type === 'case' ? `/api/cases/${id}` : `/api/executions/${id}`);
    comments = d.comments; atts = d.attachments; paint();
  };
  box.onclick = async (e) => {
    const t = e.target.closest('[data-dis], [data-act=rm-shot], [data-act=annotate]');
    if (!t) return;
    e.stopPropagation();
    try {
      if (t.dataset.dis === 'comment') {
        const ta = box.querySelector('[data-dis-text]');
        if (!ta.value.trim()) { ta.focus(); return; }
        await api('POST', `${base}/comments`, { body: ta.value }); await refresh();
      } else if (t.dataset.dis === 'del') { await api('DELETE', `/api/item-comments/${t.dataset.id}`); await refresh(); }
      else if (t.dataset.act === 'rm-shot') { await api('DELETE', `/api/attachments/${t.dataset.id}`); await refresh(); }
      else if (t.dataset.act === 'annotate') await openAnnotator(Number(t.dataset.id), refresh);
    } catch (err) { fail(err); }
  };
  box.onchange = async (e) => {
    if (!e.target.matches('[data-dis-upload]')) return;
    e.stopPropagation();
    try { await uploadImages(`${base}/attachments`, filesFrom(e.target.files)); await refresh(); } catch (err) { fail(err); }
  };
  paint();
}

// Saved views: a drop-down of named filter sets (yours first, then shared ones) plus Save and Delete.
const VIEW_LABEL = { cases: 'test cases', bugs: 'bugs', cycles: 'test cycles' };
const VIEW_SEL = {}; // the view last picked per list, so it stays selected when the list redraws
async function mountViews(box, scope, getState, applyState) {
  if (!box) return;
  let views = [];
  try { views = await api('GET', `/api/projects/${STATE.pid}/views?scope=${scope}`); } catch { return; }
  let current = views.find((v) => v.id === VIEW_SEL[scope]) || null;
  const paint = () => {
    box.innerHTML = `<select data-v-pick aria-label="Saved views"><option value="">Saved views${views.length ? '' : ' (none yet)'}</option>
      ${views.map((v) => `<option value="${v.id}"${current && current.id === v.id ? ' selected' : ''}>${esc(v.name)}${v.mine ? '' : ` — ${esc(v.owner)}`}${v.shared && v.mine ? ' (shared)' : ''}</option>`).join('')}</select>
      <button type="button" class="btn small ghost" data-v-save>${withIcon('plus', 'Save view')}</button>
      ${current && (current.mine || STATE.user.role === 'admin') ? `<button type="button" class="icon danger" data-v-del title="Delete this view" aria-label="Delete view ${esc(current.name)}">${icon('trash')}</button>` : ''}`;
  };
  box.onchange = (e) => {
    if (!e.target.matches('[data-v-pick]')) return;
    e.stopPropagation();
    current = views.find((v) => String(v.id) === e.target.value) || null;
    VIEW_SEL[scope] = current ? current.id : null;
    if (current) applyState(current.state); else paint();
  };
  box.onclick = async (e) => {
    const save = e.target.closest('[data-v-save]'), del = e.target.closest('[data-v-del]');
    if (!save && !del) return;
    e.stopPropagation();
    try {
      if (del) {
        if (!confirm(`Delete the view “${current.name}”?`)) return;
        await api('DELETE', `/api/views/${current.id}`);
        views = views.filter((v) => v.id !== current.id); current = null; VIEW_SEL[scope] = null; paint(); return;
      }
      openDialog(`<h2>Save view</h2><p class="muted">Saves the current filters for ${VIEW_LABEL[scope]}. Using an existing name replaces that view.</p>
        <label>Name<input name="name" required maxlength="60" autofocus value="${current ? esc(current.name) : ''}"></label>
        ${STATE.user.role === 'viewer' ? '' : '<label class="check"><input type="checkbox" name="shared"> Share with everyone on this project</label>'}
        <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></footer>`,
        async (fd) => {
          const r = await api('POST', `/api/projects/${STATE.pid}/views`, { scope, name: fd.get('name'), shared: fd.get('shared') === 'on', state: getState() });
          views = await api('GET', `/api/projects/${STATE.pid}/views?scope=${scope}`);
          current = views.find((v) => v.id === r.id) || null; VIEW_SEL[scope] = current ? current.id : null; paint(); toast('View saved');
        });
    } catch (err) { fail(err); }
  };
  paint();
}

// ---------- reports ----------
// Status colours are validated for colour-blind separation; Fail and Blocked also carry a texture, and every
// mark has a label, a tooltip and a table equivalent.
const STATUS_KEYS = [
  { key: 'pass', label: 'Pass', icon: 'check' },
  { key: 'fail', label: 'Fail', icon: 'x' },
  { key: 'blocked', label: 'Blocked', icon: 'ban' },
  { key: 'rest', label: 'Not run', icon: 'minus' },
];
const legend = (counts) => `<div class="legend-row">${STATUS_KEYS.map((s) => `<span class="lg"><i class="sw sw-${s.key}"></i>${icon(s.icon)}<span>${s.label}${counts ? ` <b>${counts[s.key]}</b>` : ''}</span></span>`).join('')}</div>`;
const rate = (c) => { const d = c.pass + c.fail + c.blocked; return d ? Math.round((c.pass / d) * 100) : null; };

function topRounded(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, h, w / 2));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function trendSvg(trend, mode, W) {
  const H = 300, m = { l: 48, r: 10, t: 22, b: 54 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const rows = trend.map((c) => ({ ...c, rest: c.not_executed + c.in_progress }));
  const step = Math.max(1, Math.ceil(Math.max(1, ...rows.map((c) => c.total)) / 4));
  const max = mode === 'percent' ? 100 : step * 4;
  const y = (v) => m.t + ih - (v / max) * ih;
  const band = iw / Math.max(rows.length, 1), bw = Math.min(64, band * 0.62);
  const grid = [0, 1, 2, 3, 4].map((i) => { const v = (max / 4) * i; return `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ytick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}${mode === 'percent' ? '%' : ''}</text>`; }).join('');
  const bars = rows.map((c, i) => {
    const cx = m.l + band * i + band / 2, x0 = cx - bw / 2;
    let acc = 0;
    const present = STATUS_KEYS.filter((s) => c[s.key] > 0);
    const last = present[present.length - 1];
    const segs = present.map((s) => {
      const v = mode === 'percent' ? (c[s.key] / c.total) * 100 : c[s.key];
      const top = y(acc + v), h = y(acc) - top;
      acc += v;
      const gap = s !== last && h > 3 ? 2 : 0; // 2px surface gap between stacked fills (trimmed from the top of each lower segment)
      const hh = Math.max(1, h - gap);
      const d = s === last ? topRounded(x0, top + gap, bw, hh, 4) : `M${x0},${top + gap}h${bw}v${hh}h${-bw}Z`;
      const tex = s.key === 'fail' ? 'url(#tx-hatch)' : s.key === 'blocked' ? 'url(#tx-dots)' : '';
      return `<path class="seg seg-${s.key}" d="${d}"/>${tex ? `<path d="${d}" fill="${tex}" class="tx"/>` : ''}`;
    }).join('');
    const pr = rate(c);
    const label = c.total ? `<text class="pct" x="${cx}" y="${y(acc) - 7}" text-anchor="middle">${pr === null ? '' : pr + '%'}</text>` : `<text class="pct" x="${cx}" y="${y(0) - 7}" text-anchor="middle">no tests</text>`;
    const name = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
    const aria = `${c.key} ${c.name}: ${c.pass} passed, ${c.fail} failed, ${c.blocked} blocked, ${c.rest} not run${pr === null ? '' : `, pass rate ${pr}%`}`;
    return `<g class="bar" data-i="${i}" tabindex="0" role="img" aria-label="${esc(aria)}">
      <rect class="hit" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih + m.b}"/>${segs}${label}
      <text class="xk" x="${cx}" y="${H - m.b + 18}" text-anchor="middle">${esc(name(c.key, 12))}</text>
      <text class="xb" x="${cx}" y="${H - m.b + 34}" text-anchor="middle">${esc(name(c.build || c.name, 14))}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="Pass, fail, blocked and not-run results for the last ${rows.length} test cycles">
    <defs>
      <pattern id="tx-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" class="txl" stroke-width="2"/></pattern>
      <pattern id="tx-dots" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r="1.3" class="txd"/></pattern>
    </defs>${grid}${bars}</svg>`;
}

function hbars(items, { empty }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return items.length ? `<div class="hbars">${items.map((i) => `<div class="hrow"><span class="hl">${i.label}</span>
    <span class="hb"><i style="width:${(i.value / max) * 100}%"></i></span><b class="hv">${i.value}</b></div>`).join('')}</div>` : `<p class="muted">${empty}</p>`;
}

async function viewReports() {
  let n = Number(sessionStorage.getItem('rcycles')) || 10, mode = 'count';
  let filters = {};
  try { filters = JSON.parse(sessionStorage.getItem('rfilters') || '{}'); } catch { filters = {}; }
  const fq = () => Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  const filtered = () => Object.values(filters).some(Boolean);
  const data = () => api('GET', `/api/projects/${STATE.pid}/reports?cycles=${n}${fq()}`);
  let r;
  const [folderList, planList] = await Promise.all([api('GET', `/api/projects/${STATE.pid}/folders`).catch(() => []), api('GET', `/api/projects/${STATE.pid}/plans`)]);
  try { r = await data(); } catch (err) { filters = {}; r = await data(); }
  const filterBar = () => `<section class="card filterbar" aria-label="Report filters"><div class="filtergrid">
      <label>From<input type="date" data-rf="from" value="${esc(filters.from || '')}"></label>
      <label>To<input type="date" data-rf="to" value="${esc(filters.to || '')}"></label>
      <label>Folder<select data-rf="folder"><option value="">All folders</option>${(folderList || []).map((f) => { const v = typeof f === 'string' ? f : f.path || f.name; return `<option${filters.folder === v ? ' selected' : ''}>${esc(v)}</option>`; }).join('')}</select></label>
      <label>Label<input data-rf="label" value="${esc(filters.label || '')}" placeholder="e.g. smoke"></label>
      <label>Plan<select data-rf="plan_id"><option value="">All plans</option>${planList.map((p) => `<option value="${p.id}"${String(filters.plan_id) === String(p.id) ? ' selected' : ''}>${esc(p.key)} ${esc(p.name)}</option>`).join('')}</select></label>
      <span class="fbtns"><button type="button" class="btn small primary" data-act="apply-filters">Apply</button>${filtered() ? ' <button type="button" class="btn small ghost" data-act="clear-filters">Clear</button>' : ''}</span></div>
      ${filtered() ? '<p class="muted">Filtered view. Dates apply to when cycles were created, tests were run and bugs were filed.</p>' : ''}</section>`;
  const trace = await api('GET', `/api/projects/${STATE.pid}/traceability`);
  const caseLink = (id, key) => (id ? `<a href="#/cases/${id}">${esc(key)}</a>` : esc(key));

  const paint = () => {
    const cov = r.coverage;
    const covCounts = { pass: cov.Pass, fail: cov.Fail, blocked: cov.Blocked, rest: cov['Never run'] + cov['In Progress'] };
    const covTotal = Object.values(covCounts).reduce((a, b) => a + b, 0);
    const last = r.trend.at(-1);
    const lastRate = last ? rate(last) : null;
    view.innerHTML = `
      <header class="head"><h1>Reports</h1><span>
        <label class="inline">Show <select id="rcycles" aria-label="Number of cycles">${[5, 10, 20, 30].map((v) => `<option${v === n ? ' selected' : ''}>${v}</option>`).join('')}</select> cycles</label>
        <button type="button" class="btn ghost" data-act="export">${withIcon('download', 'Export trend')}</button></span></header>
      ${filterBar()}
      <section class="tiles">
        <div class="tile"><b>${lastRate === null ? '—' : lastRate + '%'}</b><span>Pass rate, latest cycle${last ? ` (${esc(last.key)})` : ''}</span></div>
        <div class="tile"><b>${cov['Never run']}</b><span>Test cases never run</span></div>
        <div class="tile"><b>${r.bugs.open}</b><span>Open bugs${r.bugs.open ? `, ${r.bugs.avgOpenAgeDays} days old on average` : ''}</span></div>
        <div class="tile"><b>${r.flaky.length}</b><span>Flaky test cases</span></div>
      </section>
      <section class="card">
        <div class="chart-head"><h2>Results by cycle</h2>
          <div class="seg-toggle" role="group" aria-label="Chart scale"><button type="button" data-mode="count" aria-pressed="${mode === 'count'}">Count</button><button type="button" data-mode="percent" aria-pressed="${mode === 'percent'}">Percent</button></div></div>
        ${r.trend.length ? `${legend()}<div class="chart-wrap" id="trend"><div class="tip" hidden></div></div>
        <details class="tableview"><summary>Show as a table</summary><div class="tscroll"><table><thead><tr><th>Cycle</th><th>Build</th><th class="num">Total</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Blocked</th><th class="num">Not run</th><th class="num">Pass rate</th></tr></thead><tbody>
          ${r.trend.map((c) => `<tr><td><a href="#/cycles/${c.id}"><span class="key">${esc(c.key)}</span> ${esc(c.name)}</a></td><td>${esc(c.build)}</td><td class="num">${c.total}</td><td class="num">${c.pass}</td><td class="num">${c.fail}</td><td class="num">${c.blocked}</td><td class="num">${c.not_executed + c.in_progress}</td><td class="num">${rate(c) === null ? '—' : rate(c) + '%'}</td></tr>`).join('')}</tbody></table></div></details>`
        : '<p class="empty">No test cycles yet. Create one and run some tests to see results here.</p>'}
      </section>
      <div class="grid2">
        <section class="card"><h2>Where each test case stands</h2>
          ${covTotal ? `<div class="bar thick" role="img" aria-label="${covCounts.pass} pass, ${covCounts.fail} fail, ${covCounts.blocked} blocked, ${covCounts.rest} not run, of ${covTotal} test cases">${STATUS_KEYS.filter((s) => covCounts[s.key]).map((s) => `<i class="${s.key === 'rest' ? 'rest' : s.key}" style="width:${(covCounts[s.key] / covTotal) * 100}%" title="${s.label}: ${covCounts[s.key]}"></i>`).join('')}</div>${legend(covCounts)}<p class="muted">Based on the most recent result of each active test case.</p>` : '<p class="empty">No test cases yet.</p>'}
        </section>
        <section class="card"><h2>Open bugs by severity</h2>
          ${hbars(r.bugs.openBySeverity.map((b) => ({ label: esc(b.severity), value: b.count })), { empty: 'No bugs.' })}
          ${r.bugs.byCase.length ? `<h3>Test cases that found the most bugs</h3><table class="mini"><tbody>${r.bugs.byCase.slice(0, 5).map((b) => `<tr><td>${caseLink(b.case_id, b.case_key)}</td><td class="num">${b.count} bug${b.count === 1 ? '' : 's'}</td><td class="num muted">${b.open} open</td></tr>`).join('')}</tbody></table>` : ''}
        </section>
        <section class="card"><h2>Most failures</h2>
          ${r.failing.length ? `<div class="tscroll"><table><thead><tr><th>Test case</th><th class="num">Runs</th><th class="num">Failed</th><th class="w-bar">Fail rate</th></tr></thead><tbody>${r.failing.map((f) => `<tr><td>${caseLink(f.case_id, f.key)} ${esc(f.title)}</td><td class="num">${f.runs}</td><td class="num">${f.fails}</td>
            <td><div class="bar" role="img" aria-label="${Math.round((f.fails / f.runs) * 100)}% of runs failed"><i class="fail" style="width:${(f.fails / f.runs) * 100}%"></i></div></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing has failed yet.</p>'}
        </section>
        <section class="card"><h2>Flaky test cases</h2><p class="muted">Results that keep switching between pass and fail.</p>
          ${r.flaky.length ? `<div class="tscroll"><table><thead><tr><th>Test case</th><th class="num">Runs</th><th class="num">Switches</th><th>Last</th></tr></thead><tbody>${r.flaky.map((f) => `<tr><td>${caseLink(f.case_id, f.key)} ${esc(f.title)}</td><td class="num">${f.runs}</td><td class="num">${f.flips}</td><td>${pill(f.last)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None. Results have been stable.</p>'}
        </section>
        <section class="card"><h2>Slowest automated tests</h2><p class="muted">Average time reported by CI.</p>
          ${(r.slowest || []).length ? `<div class="tscroll"><table><thead><tr><th>Test case</th><th class="num">Runs</th><th class="num">Average</th><th class="num">Slowest</th></tr></thead><tbody>${r.slowest.map((x) => `<tr><td>${caseLink(x.case_id, x.key)} ${esc(x.title)}</td><td class="num">${x.runs}</td><td class="num">${fmtMs(x.avg_ms)}</td><td class="num">${fmtMs(x.max_ms)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No timings yet. Send <code>duration_ms</code> with CI results (JUnit reports include it).</p>'}
        </section>
      </div>
      <section class="card"><div class="chart-head"><h2>Requirement coverage</h2><button type="button" class="btn ghost small" data-act="export-trace">${withIcon('download', 'Export')}</button></div>
        ${trace.requirements.length || trace.uncovered.length ? `<p class="muted"><b>${trace.summary.requirements}</b> requirement${trace.summary.requirements === 1 ? '' : 's'}: ${trace.summary.passing} passing, ${trace.summary.failing} failing, ${trace.summary.blocked} blocked, ${trace.summary.partly} partly run, ${trace.summary.notRun} not run · <b>${trace.summary.uncovered}</b> test case${trace.summary.uncovered === 1 ? '' : 's'} not linked to any requirement</p>
        ${trace.requirements.length ? `<div class="tscroll"><table><thead><tr><th>Requirement</th><th>Coverage</th><th>Test cases and their last result</th></tr></thead><tbody>${trace.requirements.map((q) => `<tr><td>${q.url ? `<a href="${esc(safeUrl(q.url))}" target="_blank" rel="noopener noreferrer">${esc(q.ref)}</a>` : `<b>${esc(q.ref)}</b>`}${q.title ? `<br><span class="muted">${esc(q.title)}</span>` : ''}</td>
          <td>${pill(q.status)}</td><td>${q.cases.map((c) => `<a class="chip ext" href="#/cases/${c.id}"><span>${esc(c.key)}</span><small>${esc(c.last_status)}${c.open_bugs ? `, ${c.open_bugs} open bug${c.open_bugs === 1 ? '' : 's'}` : ''}</small></a>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No test case is linked to a requirement yet. Add requirements on a test case’s page.</p>'}
        ${trace.uncovered.length ? `<details class="tableview"><summary>Show the ${trace.uncovered.length} test case${trace.uncovered.length === 1 ? '' : 's'} without a requirement</summary><p>${trace.uncovered.map((c) => `<a class="chip ext" href="#/cases/${c.id}"><span>${esc(c.key)} ${esc(c.title)}</span></a>`).join(' ')}</p></details>` : ''}`
        : '<p class="muted">No test cases yet.</p>'}
      </section>
      <section class="card"><h2>Tester activity, last 30 days</h2>
        ${r.activity.length ? `<div class="tscroll"><table><thead><tr><th>Tester</th><th class="num">Executed</th><th class="num">Passed</th><th class="num">Failed</th></tr></thead><tbody>${r.activity.map((a) => `<tr><td>${esc(a.name)}</td><td class="num">${a.executed}</td><td class="num">${a.pass}</td><td class="num">${a.fail}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No executions recorded in the last 30 days.</p>'}
      </section>`;
    drawTrend();
  };

  const drawTrend = () => {
    const wrap = $('#trend');
    if (!wrap) return;
    const tip = $('.tip', wrap);
    const svgHost = document.createElement('div');
    svgHost.innerHTML = trendSvg(r.trend, mode, Math.max(360, Math.floor(wrap.clientWidth)));
    wrap.querySelector('svg')?.remove();
    wrap.prepend(svgHost.firstElementChild);
    const svg = $('svg', wrap);
    const show = (g, clientX) => {
      const c = r.trend[Number(g.dataset.i)];
      const d = c.pass + c.fail + c.blocked, pr = rate(c);
      tip.innerHTML = `<b>${esc(c.key)} ${esc(c.name)}</b><span class="muted">${esc([c.build, c.environment].filter(Boolean).join(' · '))}</span>
        ${STATUS_KEYS.map((s) => { const v = s.key === 'rest' ? c.not_executed + c.in_progress : c[s.key]; return `<span class="trow"><i class="sw sw-${s.key}"></i>${s.label}<b>${v}</b></span>`; }).join('')}
        <span class="trow">Pass rate<b>${pr === null ? '—' : pr + '%'}</b></span><span class="muted">${d} of ${c.total} decided</span>`;
      tip.hidden = false;
      const wr = wrap.getBoundingClientRect();
      const x = clientX - wr.left;
      tip.style.left = `${Math.max(4, Math.min(x + 16, wr.width - tip.offsetWidth - 4))}px`;
      tip.style.top = '8px';
      svg.querySelectorAll('.bar').forEach((b) => b.classList.toggle('on', b === g));
    };
    const hide = () => { tip.hidden = true; svg.querySelectorAll('.bar.on').forEach((b) => b.classList.remove('on')); };
    svg.addEventListener('pointermove', (e) => { const g = e.target.closest('.bar'); if (g) show(g, e.clientX); else hide(); });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focusin', (e) => { const g = e.target.closest('.bar'); if (g) { const b = g.getBoundingClientRect(); show(g, b.left + b.width / 2); } });
    svg.addEventListener('focusout', hide);
    svg.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  };

  view.onclick = async (e) => {
    const fa = e.target.closest('[data-act=apply-filters], [data-act=clear-filters]');
    if (fa) {
      filters = fa.dataset.act === 'clear-filters' ? {} : Object.fromEntries($$('[data-rf]', view).map((i) => [i.dataset.rf, i.value.trim()]));
      try { sessionStorage.setItem('rfilters', JSON.stringify(filters)); } catch { /* ignore */ }
      try { r = await data(); paint(); } catch (err) { fail(err); }
      return;
    }
    const m = e.target.closest('[data-mode]');
    if (m) { mode = m.dataset.mode; $$('[data-mode]', view).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode))); drawTrend(); return; }
    if (e.target.closest('[data-act=export-trace]')) { openExport({ title: 'Export requirement coverage', base: `/api/projects/${STATE.pid}/traceability/export`, note: 'One row per requirement and test case, plus test cases without a requirement.' }); return; }
    if (e.target.closest('[data-act=export]')) openExport({ title: 'Export cycle trend', base: `/api/projects/${STATE.pid}/reports/export`, scopes: [{ label: `Last ${n} cycles${filtered() ? ' (with the current filters)' : ''}`, params: `cycles=${n}${fq()}` }], note: 'One row per cycle with counts and pass rate.' });
  };
  view.onchange = async (e) => {
    if (e.target.id !== 'rcycles') return;
    n = Number(e.target.value);
    sessionStorage.setItem('rcycles', String(n));
    r = await data();
    paint();
  };
  let timer;
  const onResize = () => { clearTimeout(timer); timer = setTimeout(() => { if (document.contains($('#trend'))) drawTrend(); else window.removeEventListener('resize', onResize); }, 120); };
  window.addEventListener('resize', onResize);
  paint();
}

// ---------- screenshot annotator ----------
const ANN_COLORS = [{ name: 'Red', hex: '#e5234b' }, { name: 'Yellow', hex: '#f5c518' }, { name: 'Blue', hex: '#1478a8' }, { name: 'Black', hex: '#111111' }];

async function openAnnotator(attId, onSaved) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Could not load the screenshot'));
    i.src = `/api/attachments/${attId}?t=${Date.now()}`;
  });
  const W = img.naturalWidth, H = img.naturalHeight;
  const shapes = [];
  let canvas = null, commitText = () => {}; // set up when the dialog opens, used by Save
  openDialog(`<h2>Annotate screenshot</h2>
    <div class="annbar" role="toolbar" aria-label="Annotation tools">
      <div class="seg-toggle" role="group" aria-label="Tool">${[['arrow', 'Arrow'], ['box', 'Box'], ['pen', 'Pen'], ['text', 'Text']].map(([k, l]) => `<button type="button" data-tool="${k}" aria-pressed="${k === 'arrow'}">${l}</button>`).join('')}</div>
      <div class="swatches" role="group" aria-label="Colour">${ANN_COLORS.map((c, i) => `<button type="button" class="swatch" data-color="${c.hex}" style="background:${c.hex}" aria-label="${c.name}" title="${c.name}" aria-pressed="${i === 0}"></button>`).join('')}</div>
      <button type="button" class="btn ghost small" data-an="undo">${withIcon('rotate', 'Undo')}</button>
      <button type="button" class="btn ghost small" data-an="clear">${withIcon('trash', 'Clear')}</button></div>
    <div class="annwrap" id="annwrap"><canvas id="ann" width="${W}" height="${H}" aria-label="Screenshot to annotate"></canvas><input id="ann-text" class="anntext" hidden maxlength="120" aria-label="Annotation text"></div>
    <p class="muted">Drag to draw. For text, click where it should go, type, press Enter. Saving replaces this screenshot.</p>
    <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${withIcon('save', 'Save')}</button></footer>`,
    async () => {
      if (!shapes.length) throw new Error('Draw something first, or cancel');
      commitText();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
      await api('PUT', `/api/attachments/${attId}/content`, { mime: 'image/png', data });
      toast('Screenshot saved');
      if (onSaved) await onSaved();
    },
    (form) => {
      canvas = $('#ann', form);
      const ctx = canvas.getContext('2d'), tin = $('#ann-text', form);
      const lw = Math.max(3, Math.round(W / 300)), fs = Math.max(18, Math.round(W / 40));
      let tool = 'arrow', color = ANN_COLORS[0].hex, drawing = null;
      const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height }; };
      const stroke = (s) => {
        ctx.strokeStyle = ctx.fillStyle = s.color; ctx.lineWidth = lw; ctx.lineCap = ctx.lineJoin = 'round';
        if (s.type === 'pen') { ctx.beginPath(); s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); }
        else if (s.type === 'box') ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
        else if (s.type === 'arrow') {
          const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), h = lw * 5;
          ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2);
          ctx.moveTo(s.x2, s.y2); ctx.lineTo(s.x2 - h * Math.cos(a - 0.5), s.y2 - h * Math.sin(a - 0.5));
          ctx.moveTo(s.x2, s.y2); ctx.lineTo(s.x2 - h * Math.cos(a + 0.5), s.y2 - h * Math.sin(a + 0.5)); ctx.stroke();
        } else if (s.type === 'text') {
          ctx.font = `bold ${fs}px system-ui, sans-serif`; ctx.textBaseline = 'top';
          ctx.lineWidth = lw * 1.2; ctx.strokeStyle = '#fff'; ctx.strokeText(s.text, s.x, s.y); ctx.fillText(s.text, s.x, s.y);
        }
      };
      const render = () => { ctx.drawImage(img, 0, 0, W, H); shapes.forEach(stroke); if (drawing) stroke(drawing); };
      commitText = () => {
        if (tin.hidden) return;
        const text = tin.value.trim();
        if (text) shapes.push({ type: 'text', x: Number(tin.dataset.x), y: Number(tin.dataset.y), text, color });
        tin.hidden = true; tin.value = '';
        render();
      };
      canvas.addEventListener('pointerdown', (e) => {
        if (tool === 'text') {
          commitText();
          const p = pt(e), r = canvas.getBoundingClientRect(), wrap = $('#annwrap', form);
          tin.dataset.x = p.x; tin.dataset.y = p.y;
          tin.style.left = `${e.clientX - r.left + canvas.offsetLeft}px`; tin.style.top = `${e.clientY - r.top + canvas.offsetTop}px`;
          tin.style.color = color; tin.style.fontSize = `${Math.max(14, (fs * r.width) / W)}px`;
          tin.hidden = false; tin.focus(); wrap.scrollLeft = wrap.scrollLeft;
          e.preventDefault();
          return;
        }
        canvas.setPointerCapture(e.pointerId);
        const p = pt(e);
        drawing = tool === 'pen' ? { type: 'pen', pts: [p], color } : { type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color };
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const p = pt(e);
        if (drawing.type === 'pen') drawing.pts.push(p); else { drawing.x2 = p.x; drawing.y2 = p.y; }
        render();
      });
      const end = () => {
        if (!drawing) return;
        const s = drawing; drawing = null;
        const tiny = s.type === 'pen' ? s.pts.length < 2 : Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < lw * 2;
        if (!tiny) shapes.push(s);
        render();
      };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
      tin.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitText(); }
        if (e.key === 'Escape') { e.stopPropagation(); tin.hidden = true; tin.value = ''; }
      });
      form.addEventListener('click', (e) => {
        const t = e.target.closest('[data-tool]'), c = e.target.closest('[data-color]'), a = e.target.closest('[data-an]');
        if (t) { commitText(); tool = t.dataset.tool; $$('[data-tool]', form).forEach((b) => b.setAttribute('aria-pressed', String(b === t))); }
        if (c) { color = c.dataset.color; $$('[data-color]', form).forEach((b) => b.setAttribute('aria-pressed', String(b === c))); }
        if (a && a.dataset.an === 'undo') { commitText(); shapes.pop(); render(); }
        if (a && a.dataset.an === 'clear') { tin.hidden = true; shapes.length = 0; render(); }
      });
      render();
    });
}

// ---------- integrations ----------
const KIND_LABEL = { github: 'GitHub', jira: 'Jira' };
const safeUrl = (u) => (/^https?:\/\//i.test(String(u)) ? String(u) : '#');

async function viewIntegrations() {
  const list = await api('GET', `/api/projects/${STATE.pid}/integrations`);
  const by = Object.fromEntries(list.map((i) => [i.kind, i]));
  const proj = STATE.projects.find((p) => p.id === STATE.pid);
  const val = (kind, f, d = '') => esc(by[kind] ? (Array.isArray(by[kind].config[f]) ? by[kind].config[f].join(', ') : by[kind].config[f] ?? d) : d);
  const field = (kind, f, label, { type = 'text', hint = '', ph = '', def = '' } = {}) =>
    `<label>${label}${hint ? `<small>${hint}</small>` : ''}<input data-f="${f}" type="${type}" value="${type === 'password' ? '' : val(kind, f, def)}" placeholder="${esc(type === 'password' && by[kind] ? 'Saved. Leave blank to keep it.' : ph)}" autocomplete="off" spellcheck="false"></label>`;
  const head = (kind, title, blurb) => `<div class="int-head"><h2>${icon('plug')} ${title}</h2>${by[kind] ? pill('Connected') : '<span class="pill">Not set up</span>'}</div><p class="muted">${blurb}</p>`;
  const sv = (kind, k, d) => (by[kind] && by[kind].config.sync && by[kind].config.sync[k] !== undefined ? by[kind].config.sync[k] : d);
  const syncBlock = (kind) => `<h3>Keep bug status in step</h3>
    <label class="check"><input type="checkbox" data-s="pull"${sv(kind, 'pull', true) ? ' checked' : ''}> When the issue changes, update the bug <small>(checked every few minutes, or instantly with a webhook)</small></label>
    <label class="check"><input type="checkbox" data-s="push"${sv(kind, 'push', false) ? ' checked' : ''}> When someone changes the bug’s status in Proofdeck, close or reopen the issue</label>
    <div class="two"><label>When the issue is closed, set the bug to<select data-s="onClose">${['Resolved', 'Closed'].map((o) => `<option${sv(kind, 'onClose', 'Resolved') === o ? ' selected' : ''}>${o}</option>`).join('')}</select></label>
      <label>When it is reopened, set the bug to<select data-s="onReopen">${['Open', 'In Progress'].map((o) => `<option${sv(kind, 'onReopen', 'Open') === o ? ' selected' : ''}>${o}</option>`).join('')}</select></label></div>
    ${by[kind] ? `<div class="int-actions"><button type="button" class="btn ghost small" data-act="syncall" data-kind="${kind}">${withIcon('rotate', 'Sync all bugs now')}</button>
      <button type="button" class="btn ghost small" data-act="webhook" data-kind="${kind}">Instant updates (webhook)…</button></div><div class="webhook" data-hook="${kind}" hidden></div>` : ''}`;
  const actions = (kind) => `<div class="int-actions"><button type="button" class="btn ghost" data-act="test" data-kind="${kind}">Test connection</button>
    <button type="button" class="btn primary" data-act="save" data-kind="${kind}">${withIcon('save', 'Save')}</button>
    ${by[kind] ? `<button type="button" class="btn danger" data-act="remove" data-kind="${kind}">${withIcon('trash', 'Remove')}</button>` : ''}
    <span class="int-msg" data-msg="${kind}" role="status" aria-live="polite"></span></div>`;
  view.innerHTML = `
    <header class="head"><h1>Integrations</h1></header>
    <p class="meta">Connections belong to the project <b>${esc(proj ? proj.name : '')}</b>. Tokens are stored encrypted and are never shown again. Once connected, a “Send to…” button appears on every bug.</p>
    <section class="card" data-card="github">${head('github', 'GitHub issues', 'Create an issue from a bug. Use a fine-grained personal access token with <b>Issues: Read and write</b> on the repository. GitHub’s API cannot upload images, so screenshots stay in Proofdeck.')}
      <div class="form">${field('github', 'owner', 'Owner', { ph: 'acme' })}${field('github', 'repo', 'Repository', { ph: 'shop' })}
        ${field('github', 'labels', 'Labels', { hint: 'Comma separated. A severity label is added.', def: 'bug' })}${field('github', 'token', 'Token', { type: 'password', ph: 'github_pat_…' })}
        <div class="wide">${field('github', 'base', 'API URL', { hint: 'Only change this for GitHub Enterprise, e.g. https://ghe.example.com/api/v3', def: 'https://api.github.com' })}</div></div>${syncBlock('github')}${actions('github')}</section>
    <section class="card" data-card="jira">${head('jira', 'Jira', 'Create an issue with its screenshots attached. On Jira Cloud use an API token from id.atlassian.com (Security). On Jira Server or Data Center use a personal access token from your profile. The account needs permission to create issues and add attachments.')}
      <div class="form"><label>Edition<select data-f="variant" id="jvariant"><option value="cloud"${val('jira', 'variant', 'cloud') !== 'server' ? ' selected' : ''}>Jira Cloud (atlassian.net)</option><option value="server"${val('jira', 'variant', 'cloud') === 'server' ? ' selected' : ''}>Jira Server / Data Center (self-hosted)</option></select></label>
        ${field('jira', 'base', 'Site URL', { hint: 'Must be https. Self-hosted example: https://jira.example.com (or with a context path like /jira).', ph: 'https://your-team.atlassian.net' })}<span id="jemail">${field('jira', 'email', 'Account email', { hint: 'Jira Cloud only.', ph: 'you@company.com' })}</span>
        ${field('jira', 'projectKey', 'Project key', { ph: 'PROJ' })}${field('jira', 'issueType', 'Issue type', { def: 'Bug' })}
        ${field('jira', 'labels', 'Extra labels', { hint: 'Comma separated. “proofdeck” and a severity label are always added.' })}${field('jira', 'token', 'API token / personal access token', { type: 'password', ph: 'ATATT… or the token from your profile' })}</div>${syncBlock('jira')}${actions('jira')}</section>`;
  const showEmail = () => { const j = $('#jvariant', view); if (j) $('#jemail', view).hidden = j.value === 'server'; };
  showEmail();
  view.onchange = (e) => { if (e.target.id === 'jvariant') showEmail(); };
  const read = (kind) => {
    const card = $(`[data-card=${kind}]`, view);
    const v = Object.fromEntries($$('[data-f]', card).map((i) => [i.dataset.f, i.value]));
    const { token, ...config } = v;
    const sy = (k) => $(`[data-s=${k}]`, card);
    config.sync = { pull: sy('pull').checked, push: sy('push').checked, onClose: sy('onClose').value, onReopen: sy('onReopen').value };
    return { config, token };
  };
  view.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const kind = b.dataset.kind, msg = $(`[data-msg=${kind}]`, view);
    const say = (text, bad) => { msg.textContent = text; msg.className = 'int-msg' + (bad ? ' bad' : ' good'); };
    try {
      if (b.dataset.act === 'syncall') {
        b.disabled = true;
        try { const r = await api('POST', `/api/projects/${STATE.pid}/sync`, {}); toast(`Checked ${r.checked} bug${r.checked === 1 ? '' : 's'}: ${r.changed} changed${r.errors ? `, ${r.errors} could not be reached` : ''}`); } finally { b.disabled = false; }
        return;
      }
      if (b.dataset.act === 'webhook' || b.dataset.act === 'webhook-new') {
        const box = $(`[data-hook=${kind}]`, view);
        if (b.dataset.act === 'webhook-new' && !confirm('Create a new secret? The old one stops working, so update it in the webhook settings of the other system.')) return;
        const w = await api(b.dataset.act === 'webhook' ? 'GET' : 'POST', `/api/projects/${STATE.pid}/integrations/${kind}/webhook`, b.dataset.act === 'webhook' ? undefined : {});
        const url = w.url || `${location.origin}${w.path}`;
        box.hidden = false;
        box.innerHTML = `<p class="muted">Optional. Without it, changes are picked up by the regular check. ${w.url ? '' : '<b>Set the public address on the Email page so this URL is the one other systems can reach.</b> '}Proofdeck must be reachable from ${KIND_LABEL[kind]}.</p>
          ${kind === 'github' ? `<ol><li>In the repository: <b>Settings → Webhooks → Add webhook</b>.</li><li>Payload URL: <code>${esc(url)}</code></li><li>Content type: <code>application/json</code>. Secret: below. Events: <b>Issues</b>.</li></ol>`
            : `<ol><li>In Jira: <b>System → WebHooks → Create</b>. Events: <b>Issue → updated</b>.</li><li>URL: <code>${esc(url)}?secret=${esc(w.secret)}</code></li></ol>`}
          <div class="tokenbox"><input readonly value="${esc(w.secret)}" aria-label="Webhook secret" spellcheck="false"><button type="button" class="btn ghost small" data-act="webhook-new" data-kind="${kind}">New secret</button></div>`;
        return;
      }
      if (b.dataset.act === 'remove') {
        if (!confirm(`Remove the ${KIND_LABEL[kind]} connection? Bugs already sent keep their links.`)) return;
        await api('DELETE', `/api/projects/${STATE.pid}/integrations/${kind}`);
        router();
      } else {
        b.disabled = true;
        say(b.dataset.act === 'test' ? 'Testing…' : 'Saving…');
        try {
          if (b.dataset.act === 'test') say((await api('POST', `/api/projects/${STATE.pid}/integrations/${kind}/test`, read(kind))).message);
          else { await api('PUT', `/api/projects/${STATE.pid}/integrations/${kind}`, read(kind)); toast(`${KIND_LABEL[kind]} saved`); router(); }
        } catch (err) { say(err.message, true); } finally { b.disabled = false; }
      }
    } catch (err) { fail(err); }
  };
}

// ---------- custom fields ----------
function fieldInputs(defs, values = {}, prefix = 'cf') {
  return defs.map((f) => {
    const v = values[f.key] ?? '';
    const id = `${prefix}-${f.key}`, req = f.required ? ' required' : '', label = `${esc(f.label)}${f.required ? ' *' : ''}`;
    if (f.type === 'select') return `<label>${label}<select id="${id}" data-cf="${esc(f.key)}"${req}><option value=""></option>${f.options.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    if (f.type === 'checkbox') return `<label class="check"><input type="checkbox" id="${id}" data-cf="${esc(f.key)}"${v === '1' ? ' checked' : ''}> ${label}</label>`;
    return `<label>${label}<input id="${id}" data-cf="${esc(f.key)}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}"${f.type === 'number' ? ' step="any"' : ''} value="${esc(v)}"${req} maxlength="1000"></label>`;
  }).join('');
}
const readFields = (root, defs) => Object.fromEntries(defs.map((f) => {
  const e = $(`[data-cf="${f.key}"]`, root);
  return [f.key, e ? (f.type === 'checkbox' ? e.checked : e.value) : ''];
}));

async function viewCustomFields() {
  const [defs, wf] = await Promise.all([api('GET', `/api/projects/${STATE.pid}/fields?all=1`), api('GET', `/api/projects/${STATE.pid}/workflow`)]);
  const ENT = [['case', 'Test cases'], ['bug', 'Bugs'], ['cycle', 'Test cycles']];
  const TYPE = { text: 'Text', number: 'Number', select: 'Choice', checkbox: 'Yes / no', date: 'Date' };
  view.innerHTML = `
    <header class="head"><h1>Fields &amp; workflow</h1></header>
    <p class="meta">Extra fields appear on every test case, bug or cycle in this project. A field marked required must be filled in when the form is saved.</p>
    ${ENT.map(([e, title]) => `<section class="card"><div class="chart-head"><h2>${title}</h2><button type="button" class="btn ghost small" data-act="add" data-entity="${e}">${withIcon('plus', 'Add field')}</button></div>
      ${defs.filter((f) => f.entity === e).length ? `<div class="tscroll"><table><thead><tr><th>Name</th><th>Type</th><th>Options</th><th>Required</th><th></th></tr></thead><tbody>
        ${defs.filter((f) => f.entity === e).map((f) => `<tr${f.archived ? ' class="revoked"' : ''}><td>${esc(f.label)} ${f.archived ? pill('Archived') : ''}</td><td>${TYPE[f.type]}</td><td class="muted">${esc(f.options.join(', '))}</td><td>${f.required ? 'Yes' : ''}</td>
          <td class="num"><button type="button" class="icon small" data-act="edit" data-id="${f.id}" aria-label="Edit ${esc(f.label)}" title="Edit">${icon('pencil')}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No extra fields yet.</p>'}</section>`).join('')}
    <section class="card"><h2>Approval</h2>
      <label class="check"><input type="checkbox" id="strict"${wf.strictApproval ? ' checked' : ''}> Test cases can only be approved through a review <small>(admins can still approve directly)</small></label></section>`;
  const dialog = (f, entity) => openDialog(`<h2>${f ? 'Edit field' : 'Add a field'}</h2>
    <label>Name<input name="label" required maxlength="60" value="${esc(f ? f.label : '')}" autofocus></label>
    ${f ? '' : `<label>Type<select name="type">${Object.entries(TYPE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>`}
    <label id="opts"${f && f.type !== 'select' ? ' hidden' : f ? '' : ' hidden'}>Choices <small>One per line</small><textarea name="options" rows="4">${esc(f ? f.options.join('\n') : '')}</textarea></label>
    <label class="check"><input type="checkbox" name="required"${f && f.required ? ' checked' : ''}> Required</label>
    ${f ? `<label class="check"><input type="checkbox" name="archived"${f.archived ? ' checked' : ''}> Archived <small>(hidden everywhere, values are kept)</small></label>` : ''}
    <footer>${f ? `<button type="button" class="btn danger" data-del>${withIcon('trash', 'Delete')}</button>` : ''}<span class="spacer"></span><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></footer>`,
    async (fd) => {
      const body = { label: fd.get('label'), options: fd.get('options') || '', required: fd.get('required') === 'on' };
      if (f) { await api('PUT', `/api/fields/${f.id}`, { ...body, archived: fd.get('archived') === 'on' }); } else { await api('POST', `/api/projects/${STATE.pid}/fields`, { ...body, entity, type: fd.get('type') }); }
      router();
    },
    (form) => {
      const sel = form.elements.type;
      if (sel) sel.onchange = () => { $('#opts', form).hidden = sel.value !== 'select'; };
      form.addEventListener('click', async (e) => {
        if (!e.target.closest('[data-del]')) return;
        if (!confirm(`Delete “${f.label}” and every value entered for it? Archive it instead to keep the values.`)) return;
        await api('DELETE', `/api/fields/${f.id}`); dlg.close(); router();
      });
    });
  view.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'add') dialog(null, b.dataset.entity);
    else dialog(defs.find((x) => x.id === Number(b.dataset.id)));
  };
  view.onchange = async (e) => {
    if (e.target.id !== 'strict') return;
    try { await api('PUT', `/api/projects/${STATE.pid}/workflow`, { strictApproval: e.target.checked }); toast(e.target.checked ? 'Approvals now go through a review' : 'Anyone who can edit may approve'); }
    catch (err) { fail(err); e.target.checked = !e.target.checked; }
  };
}

// ---------- notifications ----------
let notifTimer = null;
function setBadge(n) {
  const link = $('#nav a[data-nav=notifications]');
  if (!link) return;
  let b = $('.badge', link);
  if (!n) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'badge'; link.append(b); }
  b.textContent = n > 99 ? '99+' : String(n);
  b.setAttribute('aria-label', `${n} unread`);
}
async function refreshBadge() {
  try { setBadge((await fetch('/api/notifications/unread-count').then((r) => (r.ok ? r.json() : { count: 0 }))).count); } catch { /* offline */ }
}
function startNotifPolling() { stopNotifPolling(); refreshBadge(); notifTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshBadge(); }, 30000); }
function stopNotifPolling() { clearInterval(notifTimer); notifTimer = null; setBadge(0); }

async function viewNotifications() {
  const { items, unread } = await api('GET', '/api/notifications?limit=100');
  setBadge(unread);
  view.innerHTML = `
    <header class="head"><h1>Notifications</h1><span>${unread ? `<button class="btn ghost" data-act="all">${withIcon('check', 'Mark all as read')}</button>` : ''}
      <button class="btn ghost" data-act="prefs">${withIcon('mail', 'Email settings')}</button></span></header>
    <p class="meta">${unread ? `${unread} unread` : 'You are all caught up'}${STATE.user.email ? '' : ' · <a href="#" data-act="prefs">Add your email address</a> to get these by email too'}</p>
    <section class="card flush">${items.length ? `<ul class="notifs">${items.map((n) => `<li class="${n.read_at ? 'read' : 'unread'}">
      <a href="${esc(n.link || '#/notifications')}" data-id="${n.id}"><span class="dot" aria-hidden="true"></span>
        <span class="nt"><b>${esc(n.title)}</b>${n.body ? `<span class="nb">${esc(n.body)}</span>` : ''}<small>${fmtDate(n.created_at)}${n.read_at ? '' : ' · unread'}</small></span></a></li>`).join('')}</ul>`
      : '<p class="empty">Nothing yet. You will see assignments, comments, mentions and status changes here.</p>'}</section>`;
  view.onclick = async (e) => {
    const prefs = e.target.closest('[data-act=prefs]');
    if (prefs) { e.preventDefault(); openAccount(); return; }
    if (e.target.closest('[data-act=all]')) { await api('POST', '/api/notifications/read', { all: true }); router(); return; }
    const a = e.target.closest('a[data-id]');
    if (a && a.closest('li.unread')) { api('POST', '/api/notifications/read', { ids: [Number(a.dataset.id)] }).then(refreshBadge).catch(() => {}); }
  };
}

// ---------- email settings (admin) ----------
async function viewEmailSettings() {
  const st = await api('GET', '/api/settings/notifications');
  const m = st.smtp || { host: '', port: 587, security: 'starttls', user: '', hasPassword: false, from: '', fromName: 'Proofdeck', tlsVerify: true };
  view.innerHTML = `
    <header class="head"><h1>Email</h1></header>
    <p class="meta">Proofdeck can email notifications and password-reset links. It sends through your own mail server (SMTP). ${st.configured ? pill('Active') : '<span class="pill">Not set up</span>'}</p>
    <section class="card"><h2>Mail server</h2>
      <div class="form">
        <label>Server<input data-f="host" value="${esc(m.host)}" placeholder="smtp.yourcompany.com" autocomplete="off"></label>
        <label>Port<input data-f="port" type="number" min="1" max="65535" value="${esc(m.port)}"></label>
        <label>Security<select data-f="security">${[['starttls', 'STARTTLS (usually port 587)'], ['tls', 'TLS from the start (usually port 465)'], ['none', 'None (only for a server on this machine)']].map(([v, l]) => `<option value="${v}"${m.security === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="check" style="align-self:end"><input type="checkbox" data-f="tlsVerify"${m.tlsVerify ? ' checked' : ''}> Verify the server’s certificate <small>(turn off only for an internal server with a self-signed one)</small></label>
        <label>User name<small>Leave blank if the server needs no sign-in.</small><input data-f="user" value="${esc(m.user)}" autocomplete="off"></label>
        <label>Password<input data-f="password" type="password" placeholder="${m.hasPassword ? 'Saved. Leave blank to keep it.' : ''}" autocomplete="new-password"></label>
        <label>From address<input data-f="from" type="email" value="${esc(m.from)}" placeholder="proofdeck@yourcompany.com"></label>
        <label>From name<input data-f="fromName" value="${esc(m.fromName)}"></label>
      </div></section>
    <section class="card"><h2>Links and summaries</h2>
      <div class="form">
        <label class="wide">Public address of Proofdeck<small>Used for links in emails, and required for password reset by email (so a forged request can never choose where the link points). Example: https://proofdeck.yourcompany.com</small>
          <input data-f="publicUrl" value="${esc(st.publicUrl || st.envPublicUrl)}" placeholder="https://"></label>
        <label>Send daily summaries after<select data-f="digestHour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === st.digestHour ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
      </div>
      <p>${st.resetAvailable ? pill('Active') : '<span class="pill">Off</span>'} Password reset by email ${st.resetAvailable ? 'is available on the sign-in screen' : 'needs both a working mail server and a public address'}.</p></section>
    <section class="card"><h2>Try it</h2>
      <div class="int-actions"><input data-f="testTo" type="email" placeholder="send a test email to…" value="${esc(STATE.user.email || '')}" style="max-width:340px" aria-label="Test recipient">
        <button type="button" class="btn ghost" data-act="test">Send test email</button>
        <button type="button" class="btn primary" data-act="save">${withIcon('save', 'Save')}</button><span class="int-msg" id="em-msg" role="status" aria-live="polite"></span></div></section>`;
  const val = (f) => { const e = $(`[data-f=${f}]`, view); return e.type === 'checkbox' ? e.checked : e.value; };
  const body = () => ({
    smtp: { host: val('host'), port: val('port'), security: val('security'), user: val('user'), password: val('password'), from: val('from'), fromName: val('fromName'), tlsVerify: val('tlsVerify') },
    publicUrl: val('publicUrl'), digestHour: Number(val('digestHour')),
  });
  view.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const say = (t, bad) => { const el = $('#em-msg'); el.textContent = t; el.className = 'int-msg ' + (bad ? 'bad' : 'good'); };
    b.disabled = true;
    try {
      if (b.dataset.act === 'save') { await api('PUT', '/api/settings/notifications', body()); toast('Email settings saved'); router(); }
      else { say('Sending…'); await api('POST', '/api/settings/notifications/test', { to: val('testTo'), smtp: body().smtp }); say('Sent. Check the inbox.'); }
    } catch (err) { say(err.message, true); } finally { b.disabled = false; }
  };
}

// ---------- forgot / reset password ----------
function authCard(inner) {
  const a = $('#auth');
  a.hidden = false;
  a.innerHTML = `<form class="auth-card" id="auth-form"><div class="brand"><span class="logo" aria-hidden="true"></span>Proofdeck</div>${inner}</form>`;
  return $('#auth-form');
}
function renderForgot() {
  const f = authCard(`<h1>Reset your password</h1><p class="muted">Enter your username or email address. If an account matches, we email a link that works for one hour.</p>
    <label>Username or email<input name="identifier" required autofocus maxlength="254" autocomplete="username"></label>
    <p class="warn" id="auth-err" role="alert"></p><button class="btn primary" type="submit">Email me a link</button>
    <p class="muted authalt"><a href="#" id="back">Back to sign in</a></p>`);
  $('#back').onclick = (e) => { e.preventDefault(); renderAuth(false); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button', f); btn.disabled = true;
    try {
      const r = await fetch('/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: f.identifier.value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Something went wrong');
      f.innerHTML = `<div class="brand"><span class="logo" aria-hidden="true"></span>Proofdeck</div><h1>Check your email</h1><p>${esc(d.message)}</p><button class="btn primary" type="button" id="back2">Back to sign in</button>`;
      $('#back2').onclick = () => renderAuth(false);
    } catch (err) { $('#auth-err').textContent = err.message; btn.disabled = false; }
  };
}
function renderReset(token) {
  const f = authCard(`<h1>Choose a new password</h1>
    <label>New password<small>At least 8 characters.</small><input name="password" type="password" required minlength="8" autocomplete="new-password" autofocus></label>
    <label>Repeat it<input name="again" type="password" required autocomplete="new-password"></label>
    <p class="warn" id="auth-err" role="alert"></p><button class="btn primary" type="submit">Set password</button>`);
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (f.password.value !== f.again.value) { $('#auth-err').textContent = 'The two passwords differ'; return; }
    const btn = $('button', f); btn.disabled = true;
    try {
      const r = await fetch('/api/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: f.password.value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Something went wrong');
      renderAuth(false, 'Password changed. Sign in with your new password.');
    } catch (err) { $('#auth-err').textContent = err.message; btn.disabled = false; }
  };
}

// ---------- API tokens (CI) ----------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

async function viewApiTokens() {
  const list = await api('GET', `/api/projects/${STATE.pid}/api-tokens`);
  const proj = STATE.projects.find((p) => p.id === STATE.pid);
  const o = location.origin;
  const snippets = [
    ['JUnit XML (Jest, pytest, Playwright, Maven, Go…)', `curl -sS -X POST "${o}/api/ci/junit?cycle=Nightly&build=$BUILD_ID&environment=CI&autoCreate=1&createBugs=1" \\
  -H "Authorization: Bearer $PROOFDECK_TOKEN" -H "Content-Type: application/xml" \\
  --data-binary @junit.xml`],
    ['JSON results', `curl -sS -X POST ${o}/api/ci/results \\
  -H "Authorization: Bearer $PROOFDECK_TOKEN" -H "Content-Type: application/json" \\
  -d '{"cycle":{"name":"Nightly","build":"1.4.2"},"results":[
        {"case":"${proj ? proj.key : 'PROJ'}-T1","status":"Pass"},
        {"automation_key":"login.spec.ts::rejects a wrong password","status":"Fail","message":"Expected 401"}]}'`],
    ['Gate a pipeline on the result', `curl -sS "${o}/api/ci/cycle?name=Nightly&build=$BUILD_ID" \\
  -H "Authorization: Bearer $PROOFDECK_TOKEN" | jq -e '.ok'   # exits non-zero unless every test passed`],
    ['GitHub Actions step', `- name: Send results to Proofdeck
  if: always()
  env: { PROOFDECK_TOKEN: \${{ secrets.PROOFDECK_TOKEN }} }
  run: |
    curl -sS --fail-with-body -X POST "${o}/api/ci/junit?cycle=CI&build=\${{ github.run_number }}&autoCreate=1" \\
      -H "Authorization: Bearer $PROOFDECK_TOKEN" -H "Content-Type: application/xml" --data-binary @junit.xml`],
  ];
  view.innerHTML = `
    <header class="head"><h1>API tokens</h1><button class="btn primary" data-act="new">${withIcon('plus', 'Create token')}</button></header>
    <p class="meta">Tokens let your CI system record test results in <b>${esc(proj ? proj.name : '')}</b>. A token works only for the CI endpoints below, never for the rest of Proofdeck. It is shown once when you create it; only a fingerprint is kept.</p>
    <section class="card flush">${list.length ? `<table><thead><tr><th>Name</th><th>Token</th><th>Access</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((t) => `<tr${t.revoked_at ? ' class="revoked"' : ''}><td>${esc(t.name)}</td><td><code>${esc(t.prefix)}…</code></td><td>${t.scope === 'read' ? 'Read only' : 'Send results'}</td><td class="muted">${fmtDate(t.created_at)}${t.created_by_name ? ` by ${esc(t.created_by_name)}` : ''}</td>
        <td class="muted">${t.last_used_at ? fmtDate(t.last_used_at) : 'Never'}</td><td>${t.revoked_at ? pill('Revoked') : t.expires_at && t.expires_at <= new Date().toISOString() ? pill('Expired') : pill('Active')}${t.expires_at && !t.revoked_at && t.expires_at > new Date().toISOString() ? ` <small class="muted">until ${esc(t.expires_at.slice(0, 10))}</small>` : ''}</td>
        <td class="num">${t.revoked_at ? '' : `<button type="button" class="btn small danger" data-act="revoke" data-id="${t.id}" data-name="${esc(t.name)}">${withIcon('x', 'Revoke')}</button>`}</td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">No tokens yet. Create one for each pipeline, so you can revoke them separately.</p>'}</section>
    <section class="card"><h2>Send results from CI</h2>
      <p class="muted">Put the token in a secret called <code>PROOFDECK_TOKEN</code>. A cycle is found or created from its name and build, so re-sending (retries, parallel shards) adds to the same cycle.
        Cases are matched by their key (<code>${esc(proj ? proj.key : 'PROJ')}-T1</code>) or by an <b>automation key</b> set on the test case; <code>autoCreate=1</code> creates draft cases for tests Proofdeck has not seen. With <code>createBugs=1</code> a failure opens one bug per case and later failures add a comment to it.</p>
      ${snippets.map(([title, code], i) => `<h3>${esc(title)}</h3><div class="codewrap"><pre class="code" id="snip${i}">${esc(code)}</pre><button type="button" class="btn small ghost" data-copy="snip${i}">${withIcon('copy', 'Copy')}</button></div>`).join('')}
    </section>`;
  view.onclick = async (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) { toast((await copyText($(`#${cp.dataset.copy}`).textContent)) ? 'Copied' : 'Select the text and copy it', false); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    try {
      if (b.dataset.act === 'revoke') {
        if (!confirm(`Revoke “${b.dataset.name}”?\n\nPipelines using it stop working immediately. Results already recorded are kept.`)) return;
        await api('DELETE', `/api/api-tokens/${b.dataset.id}`);
        router();
      } else if (b.dataset.act === 'new') {
        openDialog(`<h2>Create API token</h2>
          <label>Name<small>What will use it, for example “GitHub Actions”.</small><input name="name" required maxlength="60" autofocus autocomplete="off"></label>
          <div class="two"><label>Access<select name="scope"><option value="write">Send results and check status</option><option value="read">Read only: check status, cannot send</option></select></label>
            <label>Expires<select name="expires_in_days"><option value="">Never</option><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="180">In 180 days</option><option value="365">In a year</option></select></label></div>
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Create token</button></footer>`,
          async (fd) => {
            const t = await api('POST', `/api/projects/${STATE.pid}/api-tokens`, { name: fd.get('name'), scope: fd.get('scope'), expires_in_days: fd.get('expires_in_days') || null });
            setTimeout(() => {
              openDialog(`<h2>Copy your token now</h2>
                <p class="warn">This is the only time it is shown. Store it in your CI system’s secrets.</p>
                <div class="tokenbox"><input id="tok" readonly value="${esc(t.token)}" aria-label="API token" spellcheck="false"><button type="button" class="btn ghost" data-copytok>${withIcon('copy', 'Copy')}</button></div>
                <footer><button type="submit" class="btn primary">Done</button></footer>`,
                async () => { router(); },
                (f) => { $('#tok', f).select(); f.addEventListener('click', async (ev) => { if (ev.target.closest('[data-copytok]')) toast((await copyText(t.token)) ? 'Copied' : 'Press Ctrl+C to copy', false); }); });
            }, 0);
          });
      }
    } catch (err) { fail(err); }
  };
}

// ---------- activity (audit log + sign-in history) ----------
const browserOf = (ua) => {
  const s = String(ua || '');
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl|node|python|axios|fetch/i.test(s) ? 'Script' : s ? 'Browser' : 'Unknown device';
  return os ? `${br} on ${os}` : br;
};

async function viewAudit() {
  let tab = 'activity', items = [], next = null, text = '', fails = false, timer;
  const load = async (more) => {
    const qs = new URLSearchParams({ limit: '50' });
    if (more && next) qs.set('before', next);
    if (tab === 'activity' && text) qs.set('q', text);
    if (tab === 'signins' && fails) qs.set('fails', '1');
    const r = await api('GET', `/api/${tab === 'activity' ? 'audit' : 'login-events'}?${qs}`);
    items = more ? items.concat(r.items) : r.items;
    next = r.next;
  };
  const table = () => (tab === 'activity'
    ? `<table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>From</th></tr></thead><tbody>${items.map((e) => `<tr><td class="muted">${fmtDate(e.at)}</td><td>${esc(e.actor_name || 'System')}</td>
        <td><b>${esc(e.action)}</b></td><td class="muted">${esc(e.detail)}</td><td class="muted">${esc(e.ip)}</td></tr>`).join('')}</tbody></table>`
    : `<table><thead><tr><th>When</th><th>Username</th><th>Result</th><th>Reason</th><th>From</th><th>Device</th></tr></thead><tbody>${items.map((e) => `<tr><td class="muted">${fmtDate(e.at)}</td><td>${esc(e.username)}</td>
        <td>${e.ok ? pill('Signed in') : '<span class="pill fail">Failed</span>'}</td><td class="muted">${esc(e.reason)}</td><td class="muted">${esc(e.ip)}</td><td class="muted">${esc(browserOf(e.user_agent))}</td></tr>`).join('')}</tbody></table>`);
  const paintBody = () => {
    $('#auditbody').innerHTML = items.length ? `<div class="tscroll">${table()}</div>${next ? `<p class="center"><button type="button" class="btn ghost" data-act="more">Show older</button></p>` : ''}`
      : `<p class="empty">${tab === 'activity' ? (text ? 'Nothing matches that search.' : 'No changes recorded yet.') : 'No sign-ins recorded.'}</p>`;
  };
  const paint = () => {
    view.innerHTML = `<header class="head"><h1>Activity</h1></header>
      <p class="meta">Who changed what, and who signed in. Passwords, tokens and other secrets are never written here. Entries are kept for ${'a year'} (activity) and 6 months (sign-ins).</p>
      <div class="filters"><span class="seg" role="group" aria-label="Show"><button type="button" class="btn small ${tab === 'activity' ? 'primary' : 'ghost'}" data-tab="activity" aria-pressed="${tab === 'activity'}">Changes</button>
        <button type="button" class="btn small ${tab === 'signins' ? 'primary' : 'ghost'}" data-tab="signins" aria-pressed="${tab === 'signins'}">Sign-ins</button></span>
        ${tab === 'activity' ? `<input id="asearch" type="search" placeholder="Search who, what or details" aria-label="Search activity" value="${esc(text)}">`
          : `<label class="check"><input type="checkbox" id="afails"${fails ? ' checked' : ''}> Only failed attempts</label>`}</div>
      <section class="card flush" id="auditbody"></section>`;
    paintBody();
  };
  await load(false);
  paint();
  view.onclick = async (e) => {
    try {
      const t = e.target.closest('[data-tab]');
      if (t) { tab = t.dataset.tab; await load(false); paint(); return; }
      if (e.target.closest('[data-act=more]')) { await load(true); paintBody(); }
    } catch (err) { fail(err); }
  };
  view.oninput = (e) => {
    if (e.target.id !== 'asearch') return;
    text = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(async () => { try { await load(false); paintBody(); } catch (err) { fail(err); } }, 250);
  };
  view.onchange = async (e) => { if (e.target.id === 'afails') { fails = e.target.checked; try { await load(false); paintBody(); } catch (err) { fail(err); } } };
}

// ---------- accounts ----------
const userSelect = (attrs, id, name) => `<select ${attrs}><option value="">Unassigned</option>
  ${id && !STATE.users.some((u) => u.id === id) ? `<option value="${id}" selected>${esc(name || 'Former user')}</option>` : ''}
  ${STATE.users.map((u) => `<option value="${u.id}"${u.id === id ? ' selected' : ''}>${esc(u.display_name)}</option>`).join('')}</select>`;
const refreshUsers = async () => { STATE.users = (await api('GET', '/api/users')).filter((u) => u.active !== 0); };
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

const forgotLine = () => (STATE.resetAvailable ? '<a href="#" id="forgot">Forgot your password?</a>' : 'Forgot your password? Ask an admin to reset it.');

function renderAuth(needsSetup, message = '') {
  // A failed single sign-on lands here as ?sso_error=…; show it once and tidy the address.
  const ssoError = new URLSearchParams(location.search).get('sso_error');
  if (ssoError) { message = ssoError; history.replaceState(null, '', location.pathname + location.hash); }
  stopNotifPolling();
  resetCasesUi(); // the next person to sign in on this tab starts with clean filters
  STATE.user = null;
  $('#me').hidden = true;
  const a = $('#auth');
  a.hidden = false;
  a.innerHTML = `<form class="auth-card" id="auth-form">
    <div class="brand"><span class="logo" aria-hidden="true"></span>Proofdeck</div>
    <h1>${needsSetup ? 'Create the admin account' : 'Sign in'}</h1>
    ${needsSetup ? '<p class="muted">First run: this account can manage users and settings. You can add teammates afterwards.</p>' : ''}
    <label>Username<input name="username" autocomplete="username" required maxlength="40" autofocus></label>
    ${needsSetup ? '<label>Your name<input name="display_name" autocomplete="name" maxlength="80"></label>' : ''}
    <label>Password<input name="password" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required${needsSetup ? ' minlength="8"' : ''}>
      ${needsSetup ? '<small>At least 8 characters.</small>' : ''}</label>
    <p class="warn" id="auth-err" role="alert">${esc(message)}</p>
    <button class="btn primary" type="submit">${needsSetup ? 'Create account' : 'Sign in'}</button>
    ${!needsSetup ? `<p class="muted authalt">${forgotLine()}</p>` : ''}</form>`;
  const bindForgot = () => { const fg = $('#forgot'); if (fg) fg.onclick = (e) => { e.preventDefault(); renderForgot(); }; };
  bindForgot();
  // The flag is read when the page loads; an admin may have switched email on since, so ask again.
  if (!needsSetup) fetch('/api/auth/me').then((r) => r.json()).then((me) => {
    STATE.resetAvailable = !!me.resetAvailable;
    const p = $('.authalt');
    if (p) { p.innerHTML = forgotLine(); bindForgot(); }
    if (me.sso && me.sso.enabled && !$('#sso-btn')) {
      const card = $('#auth-form');
      card.insertAdjacentHTML('beforeend', `<p class="sso"><a class="btn ghost" id="sso-btn" href="/api/auth/oidc/login">${esc('Sign in with ' + me.sso.label)}</a></p>`);
    }
  }).catch(() => {});
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, btn = $('button', f);
    btn.disabled = true;
    try {
      const res = await fetch(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: f.username.value, password: f.password.value, display_name: f.display_name ? f.display_name.value : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (data.needs2fa) { renderSecondFactor(data.ticket); return; }
      await startApp(data.user);
    } catch (err) { $('#auth-err').textContent = err.message; btn.disabled = false; f.password.select(); }
  };
}

// Account dialog section: turn the authenticator app on or off. Buttons here are not part of the account form.
function mountTwoFactor(box) {
  const paint = (stage = 'idle', extra = {}) => {
    const on = STATE.user.totp;
    if (stage === 'codes') {
      box.innerHTML = `<p><b>Two-factor sign-in is on.</b> Save these recovery codes somewhere safe. Each works once if you lose your phone, and they are not shown again.</p>
        <pre class="recovery">${extra.codes.map(esc).join('\n')}</pre>
        <p><button type="button" class="btn small ghost" data-tf="copy">${withIcon('copy', 'Copy codes')}</button> <button type="button" class="btn small primary" data-tf="done">I have saved them</button></p>`;
    } else if (stage === 'setup') {
      box.innerHTML = `<p>1. In your authenticator app (Google Authenticator, Authy, 1Password, Aegis…) add an account with this key, or open the link on your phone:</p>
        <p><code class="secretkey">${esc(extra.secret.match(/.{1,4}/g).join(' '))}</code> <a class="btn small ghost" href="${esc(extra.uri)}">Open in app</a></p>
        <label>2. Enter the 6-digit code it shows<input data-tf-code inputmode="numeric" autocomplete="one-time-code" maxlength="7"></label>
        <p><button type="button" class="btn small primary" data-tf="enable">Turn on</button> <button type="button" class="btn small ghost" data-tf="cancel">Cancel</button></p>`;
    } else if (stage === 'off') {
      box.innerHTML = `<p>Enter your password and a current code (or a recovery code) to turn it off.</p>
        <label>Password<input data-tf-pw type="password" autocomplete="current-password"></label>
        <label>Code<input data-tf-code autocomplete="one-time-code" maxlength="20"></label>
        <p><button type="button" class="btn small danger" data-tf="disable">Turn off</button> <button type="button" class="btn small ghost" data-tf="cancel">Cancel</button></p>`;
    } else {
      box.innerHTML = on
        ? `<p>${pill('On')} Signing in needs your password and a code from your authenticator app.</p><p><button type="button" class="btn small ghost" data-tf="off">Turn off…</button></p>`
        : `<p class="muted">Add a code from an authenticator app to your password, so a stolen password alone is not enough.</p><p><button type="button" class="btn small ghost" data-tf="setup">${withIcon('key', 'Set up')}</button></p>`;
    }
  };
  box.onclick = async (e) => {
    const b = e.target.closest('[data-tf]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    try {
      const k = b.dataset.tf, code = () => box.querySelector('[data-tf-code]').value;
      if (k === 'setup') paint('setup', await api('POST', '/api/auth/2fa/setup', {}));
      else if (k === 'enable') { const r = await api('POST', '/api/auth/2fa/enable', { code: code() }); STATE.user.totp = true; paint('codes', { codes: r.recoveryCodes }); }
      else if (k === 'copy') { await navigator.clipboard.writeText([...box.querySelectorAll('.recovery')].map((x) => x.textContent).join('\n')); toast('Recovery codes copied'); }
      else if (k === 'off') paint('off');
      else if (k === 'disable') { await api('POST', '/api/auth/2fa/disable', { password: box.querySelector('[data-tf-pw]').value, code: code() }); STATE.user.totp = false; toast('Two-factor sign-in is off'); paint(); }
      else paint();
    } catch (err) { fail(err); }
  };
  paint();
}

// Second step of signing in when the account has an authenticator app.
function renderSecondFactor(ticket, message = '') {
  const a = $('#auth');
  a.innerHTML = `<form class="auth-card" id="auth-form2">
    <div class="brand"><span class="logo" aria-hidden="true"></span>Proofdeck</div>
    <h1>Two-factor code</h1>
    <p class="muted">Open your authenticator app and enter the 6-digit code for Proofdeck. Lost your phone? Use one of your recovery codes instead.</p>
    <label>Code<input name="code" autocomplete="one-time-code" inputmode="text" required maxlength="20" autofocus></label>
    <p class="warn" id="auth-err" role="alert">${esc(message)}</p>
    <button class="btn primary" type="submit">Verify</button>
    <p class="muted authalt"><a href="#" id="back-login">Back to sign in</a></p></form>`;
  $('#back-login').onclick = (e) => { e.preventDefault(); location.reload(); };
  $('#auth-form2').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, btn = $('button', f);
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/login/2fa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, code: f.code.value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { if (res.status === 401 && /timed out|Too many/.test(data.error || '')) { $('#auth-err').textContent = data.error; btn.hidden = true; return; } throw new Error(data.error || `Request failed (${res.status})`); }
      await startApp(data.user);
    } catch (err) { $('#auth-err').textContent = err.message; btn.disabled = false; f.code.select(); }
  };
}

async function startApp(user) {
  STATE.user = user;
  $('#auth').hidden = true;
  $('#auth').innerHTML = '';
  document.body.classList.toggle('viewer', user.role === 'viewer');
  $$('[data-admin]').forEach((el) => { el.hidden = user.role !== 'admin'; });
  const me = $('#me');
  me.hidden = false;
  me.innerHTML = `<span class="avatar" aria-hidden="true">${esc(initials(user.display_name))}</span>
    <span class="me-name">${esc(user.display_name)}<small>${esc(user.role)}${user.role === 'viewer' ? ' · read-only' : ''}</small></span>`;
  me.title = 'Account';
  await refreshUsers();
  await loadProjects();
  startNotifPolling();
  await router();
}

function openAccount() {
  const u = STATE.user;
  openDialog(`<h2>Account</h2>
    <p>Signed in as <b>${esc(u.display_name)}</b> <span class="muted">(${esc(u.username)}, ${esc(u.role)})</span></p>
    <h3>Email</h3>
    <label>Email address<small>Used for notifications and to reset your password.</small><input type="email" name="email" value="${esc(u.email || '')}" maxlength="254" autocomplete="email"></label>
    <label>Email me about my notifications<select name="notify_email">${[['instant', 'Straight away'], ['daily', 'Once a day, as a summary'], ['off', 'Never (I will check in the app)']].map(([v, l]) => `<option value="${v}"${u.notify_email === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <h3>Two-factor sign-in</h3>
    <div id="twofa"></div>
    <h3>Time zone</h3>
    <label>Your time zone<small>Decides what counts as overdue or due today for you, and when your daily emails go out.</small>
      <select name="timezone"><option value="">Server default (UTC)</option>${(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).map((z) => `<option${u.timezone === z ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
    <p><button type="button" class="btn ghost small" data-act="browser-tz">Use my browser's time zone</button></p>
    <h3>Change password</h3>
    <label>Current password<input type="password" name="current" autocomplete="current-password"></label>
    <label>New password<small>At least 8 characters. Your other sessions are signed out. Leave both blank to keep your password.</small><input type="password" name="next" autocomplete="new-password" minlength="8"></label>
    <h3>Where you are signed in</h3><div id="sessions" class="sessions"><p class="muted">Loading…</p></div>
    <details id="history"><summary>Recent sign-in attempts</summary><div id="hist" class="sessions"></div></details>
    <footer><button type="button" class="btn ghost" data-signout>${withIcon('logout', 'Sign out')}</button><span class="spacer"></span>
      <button type="button" class="btn ghost" data-close>Close</button><button type="submit" class="btn primary">Save</button></footer>`,
    async (fd) => {
      const cur = fd.get('current'), nxt = fd.get('next');
      if ((cur && !nxt) || (!cur && nxt)) throw new Error('To change your password, fill in both password fields');
      const r = await api('PUT', '/api/auth/profile', { email: fd.get('email'), notify_email: fd.get('notify_email'), timezone: fd.get('timezone') });
      Object.assign(STATE.user, r.user);
      if (cur) await api('POST', '/api/auth/password', { current: cur, next: nxt });
      toast(cur ? 'Saved. Password changed' : 'Saved');
    },
    (form) => {
      const paintSessions = async () => {
        try {
          const list = await api('GET', '/api/auth/sessions');
          $('#sessions', form).innerHTML = list.map((s) => `<div class="srow"><span><b>${esc(browserOf(s.user_agent))}</b>${s.current ? ' <span class="pill pass">This device</span>' : ''}<br><small class="muted">${esc(s.ip || 'unknown address')} · signed in ${fmtDate(s.created_at)} · last active ${fmtDate(s.last_seen_at || s.created_at)}</small></span>
            ${s.current ? '' : `<button type="button" class="btn small ghost" data-kill="${s.id}">${withIcon('x', 'Sign out')}</button>`}</div>`).join('')
            + (list.length > 1 ? `<p><button type="button" class="btn small ghost" data-kill-others>${withIcon('logout', 'Sign out all other devices')}</button></p>` : '');
        } catch (err) { $('#sessions', form).innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
      };
      paintSessions();
      mountTwoFactor($('#twofa', form));
      $('#history', form).addEventListener('toggle', async (e) => {
        if (!e.target.open || $('#hist', form).dataset.done) return;
        try {
          const h = await api('GET', '/api/auth/history');
          $('#hist', form).dataset.done = '1';
          $('#hist', form).innerHTML = h.length ? h.map((x) => `<div class="srow"><span>${x.ok ? pill('Signed in') : `<span class="pill fail">Failed</span>`} <small class="muted">${fmtDate(x.at)} · ${esc(x.ip || '')} · ${esc(browserOf(x.user_agent))}${x.reason ? ` · ${esc(x.reason)}` : ''}</small></span></div>`).join('') : '<p class="muted">Nothing yet.</p>';
        } catch (err) { $('#hist', form).textContent = err.message; }
      });
      form.addEventListener('click', async (e) => {
        try {
          if (e.target.closest('[data-act=browser-tz]')) {
            const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const sel = form.querySelector('[name=timezone]');
            if (![...sel.options].some((o) => o.value === z)) sel.add(new Option(z, z));
            sel.value = z; return;
          }
          const kill = e.target.closest('[data-kill]');
          if (kill) { await api('DELETE', `/api/auth/sessions/${kill.dataset.kill}`); toast('Signed out'); await paintSessions(); return; }
          if (e.target.closest('[data-kill-others]')) { const r = await api('POST', '/api/auth/sessions/revoke-others', {}); toast(`Signed out ${r.count} other device${r.count === 1 ? '' : 's'}`); await paintSessions(); return; }
        } catch (err) { fail(err); return; }
        if (!e.target.closest('[data-signout]')) return;
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        dlg.close();
        location.hash = '#/';
        renderAuth(false);
      });
    });
}
$('#me').onclick = openAccount;

async function viewSso() {
  const c = await api('GET', '/api/settings/oidc');
  view.innerHTML = `
    <header class="head"><h1>Single sign-on</h1></header>
    <p class="meta">Let people sign in with your company account through any OpenID Connect provider (Google, Microsoft Entra, Okta, Keycloak, Authentik…). Password sign-in keeps working, so you cannot lock yourself out.</p>
    <section class="card"><form id="sso-form" class="form">
      <p class="wide">Register this redirect address with your provider: <code id="sso-redirect">${esc(c.redirectUri)}</code></p>
      <label class="check wide"><input type="checkbox" name="enabled"${c.enabled ? ' checked' : ''}> Turn on single sign-on</label>
      <label class="wide">Issuer address<small>The provider's base address, for example https://accounts.example.com or https://login.microsoftonline.com/&lt;tenant&gt;/v2.0</small>
        <input name="issuer" value="${esc(c.issuer)}" placeholder="https://" autocomplete="off"></label>
      <label>Client ID<input name="clientId" value="${esc(c.clientId)}" autocomplete="off"></label>
      <label>Client secret<small>${c.hasSecret ? 'Saved. Leave blank to keep it.' : 'Stored encrypted.'}</small><input name="clientSecret" type="password" autocomplete="new-password"></label>
      <label>Button text<small>Shown as “Sign in with …”</small><input name="label" value="${esc(c.label)}" maxlength="40" placeholder="Company account"></label>
      <label>Scopes<input name="scopes" value="${esc(c.scopes)}"></label>
      <fieldset class="wide"><legend>People who have no account yet</legend>
        <label class="check"><input type="checkbox" name="autoCreate"${c.autoCreate ? ' checked' : ''}> Create an account the first time they sign in</label>
        <div class="two"><label>New accounts get the role<select name="defaultRole">${['tester', 'viewer'].map((r) => `<option${c.defaultRole === r ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
          <label>Only for these email domains<small>Comma separated. Blank allows any verified email.</small><input name="allowedDomains" value="${esc(c.allowedDomains)}" placeholder="example.com"></label></div>
        <p class="muted">Existing accounts are matched by their verified email address the first time. Nobody is made an admin automatically.</p></fieldset>
      <p class="wide rowbtns"><button type="submit" class="btn primary">Save</button> <button type="button" class="btn ghost" data-act="test">${withIcon('check', 'Test the provider')}</button> <span id="sso-result" class="muted" role="status"></span></p>
    </form></section>`;
  const form = $('#sso-form');
  const body = () => ({ enabled: form.enabled.checked, issuer: form.issuer.value, clientId: form.clientId.value, clientSecret: form.clientSecret.value, label: form.label.value, scopes: form.scopes.value,
    autoCreate: form.autoCreate.checked, defaultRole: form.defaultRole.value, allowedDomains: form.allowedDomains.value });
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/settings/oidc', body()); toast('Saved'); router(); } catch (err) { fail(err); }
  };
  form.onclick = async (e) => {
    if (!e.target.closest('[data-act=test]')) return;
    const out = $('#sso-result'); out.textContent = 'Checking…';
    try { const r = await api('POST', '/api/settings/oidc/test', { issuer: form.issuer.value }); out.textContent = `Reachable. ${r.keys} signing key${r.keys === 1 ? '' : 's'} published.`; }
    catch (err) { out.textContent = err.message; }
  };
}

async function viewWebhooks() {
  const { items, events, kinds } = await api('GET', `/api/projects/${STATE.pid}/webhooks`);
  const KIND = { slack: 'Slack', teams: 'Microsoft Teams', generic: 'Generic (JSON)' };
  const proj = STATE.projects.find((p) => p.id === STATE.pid);
  view.innerHTML = `
    <header class="head"><h1>Webhooks</h1><button class="btn primary" data-act="add">${withIcon('plus', 'Add webhook')}</button></header>
    <p class="meta">Post a short message to Slack, Teams or your own service when something happens in ${esc(proj ? proj.name : 'this project')}. Failed posts are retried a few times.
      The address often contains a secret key, so it is stored encrypted and never shown again.</p>
    ${items.length ? `<section class="card flush"><table><thead><tr><th>Name</th><th>Sends to</th><th>When</th><th>Last post</th><th></th></tr></thead><tbody>
      ${items.map((h) => `<tr><td>${esc(h.name)}${h.active ? '' : ' <span class="pill">Paused</span>'}</td><td>${KIND[h.kind]}<br><small class="muted">${esc(h.host)}${h.signed ? ' · signed' : ''}</small></td>
        <td><small>${h.events.map((e) => esc(events[e])).join('<br>')}</small></td>
        <td>${h.last ? `${h.last.status === 'ok' ? '<span class="pill pass">Delivered</span>' : h.last.status === 'failed' ? '<span class="pill fail">Failed</span>' : '<span class="pill">Retrying</span>'}<br><small class="muted">${fmtDate(h.last.created_at)}${h.last.last_error ? ' · ' + esc(h.last.last_error) : ''}</small>` : '<span class="muted">Nothing yet</span>'}</td>
        <td class="num"><button type="button" class="btn small ghost" data-act="test" data-id="${h.id}">${withIcon('send', 'Send test')}</button>
          <button type="button" class="icon" data-act="edit" data-id="${h.id}" title="Edit ${esc(h.name)}" aria-label="Edit ${esc(h.name)}">${icon('pencil')}</button>
          <button type="button" class="icon danger" data-act="del" data-id="${h.id}" title="Delete ${esc(h.name)}" aria-label="Delete ${esc(h.name)}">${icon('trash')}</button></td></tr>`).join('')}
      </tbody></table></section>` : '<p class="empty">No webhooks yet.</p>'}`;
  const form = (h) => `<h2>${h ? 'Edit' : 'Add'} webhook</h2>
    <label>Name<input name="name" required maxlength="80" value="${esc(h ? h.name : '')}" placeholder="e.g. #qa-alerts"></label>
    ${h ? '' : `<label>Send to<select name="kind">${kinds.map((k) => `<option value="${k}">${KIND[k]}</option>`).join('')}</select></label>`}
    <label>Address<small>${h ? 'Leave blank to keep the current one. ' : ''}Slack: an incoming webhook URL. Teams: a Workflows webhook URL. Generic: any https:// endpoint that accepts JSON.</small>
      <input name="url" type="url" ${h ? '' : 'required'} maxlength="2000" placeholder="https://…" autocomplete="off"></label>
    ${!h || h.kind === 'generic' ? `<label data-generic>Signing secret <small>(generic only, optional)</small><small>Adds an X-Proofdeck-Signature header: sha256 HMAC of the body.${h ? ' Leave blank to keep it; type a space to remove it.' : ''}</small><input name="signingSecret" maxlength="200" autocomplete="off"></label>` : ''}
    <fieldset><legend>Send a message when</legend>${Object.entries(events).map(([k, l]) => `<label class="check"><input type="checkbox" name="events" value="${k}"${(h ? h.events.includes(k) : k === 'run.failed' || k === 'bug.created') ? ' checked' : ''}> ${esc(l)}</label>`).join('')}</fieldset>
    ${h ? `<label class="check"><input type="checkbox" name="active"${h.active ? ' checked' : ''}> Active</label>` : ''}
    <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${h ? 'Save' : 'Add'}</button></footer>`;
  view.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const h = items.find((x) => String(x.id) === b.dataset.id);
    try {
      if (b.dataset.act === 'add') {
        openDialog(form(null), async (fd) => {
          await api('POST', `/api/projects/${STATE.pid}/webhooks`, { name: fd.get('name'), kind: fd.get('kind'), url: fd.get('url'), signingSecret: fd.get('signingSecret') || '', events: fd.getAll('events') });
          router();
        });
      } else if (b.dataset.act === 'edit') {
        openDialog(form(h), async (fd) => {
          const sec = fd.get('signingSecret');
          await api('PUT', `/api/webhooks/${h.id}`, { name: fd.get('name'), url: fd.get('url') || undefined, events: fd.getAll('events'), active: fd.get('active') === 'on',
            ...(h.kind === 'generic' && sec ? { signingSecret: sec.trim() } : {}) });
          router();
        });
      } else if (b.dataset.act === 'test') {
        await api('POST', `/api/webhooks/${h.id}/test`, {});
        toast('Test message queued. Reload in a moment to see the result.');
      } else if (b.dataset.act === 'del') {
        if (!confirm(`Delete the webhook “${h.name}”?`)) return;
        await api('DELETE', `/api/webhooks/${h.id}`); router();
      }
    } catch (err) { fail(err); }
  };
}

async function viewTrash() {
  const { items, days } = await api('GET', `/api/projects/${STATE.pid}/trash`);
  const admin = STATE.user.role === 'admin';
  const KIND = { case: 'Test case', cycle: 'Test cycle', bug: 'Bug', execution: 'Test run' };
  view.innerHTML = `
    <header class="head"><h1>Trash</h1>${admin && items.length ? `<button class="btn ghost" data-act="empty">${withIcon('trash', 'Empty trash')}</button>` : ''}</header>
    <p class="meta">Deleted test cases, cycles and bugs stay here for ${days} days and can be restored with their steps, comments, files and results.</p>
    ${items.length ? `<section class="card flush"><table><thead><tr><th>Item</th><th>Type</th><th>Deleted</th><th>By</th><th></th></tr></thead><tbody>
      ${items.map((t) => `<tr><td>${esc(t.label)}</td><td class="muted">${KIND[t.kind] || t.kind}</td><td class="muted">${fmtDate(t.deleted_at)}</td><td class="muted">${esc(t.deleted_by_name || '—')}</td>
        <td class="num"><button type="button" class="btn small ghost" data-act="restore" data-id="${t.id}">${withIcon('rotate', 'Restore')}</button>
        ${admin ? `<button type="button" class="icon danger" data-act="purge" data-id="${t.id}" title="Delete for good" aria-label="Delete ${esc(t.label)} for good">${icon('trash')}</button>` : ''}</td></tr>`).join('')}
      </tbody></table></section>` : '<p class="empty">Trash is empty.</p>'}`;
  view.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    try {
      if (b.dataset.act === 'restore') {
        const r = await api('POST', `/api/trash/${b.dataset.id}/restore`, {});
        toast(`Restored. <a href="#/${KIND_PATH[r.kind]}/${r.id}">Open it</a>`, false, 8000); router();
      } else if (b.dataset.act === 'purge') {
        if (!confirm('Delete this for good? It cannot be restored afterwards.')) return;
        await api('DELETE', `/api/trash/${b.dataset.id}`); router();
      } else if (b.dataset.act === 'empty') {
        if (!confirm(`Empty the trash? ${items.length} item${items.length === 1 ? '' : 's'} will be deleted for good.`)) return;
        await api('DELETE', `/api/projects/${STATE.pid}/trash`); router();
      }
    } catch (err) { fail(err); }
  };
}

async function viewUsers() {
  const users = await api('GET', '/api/users');
  const ROLE_HELP = { admin: 'Manages users and settings, plus everything testers can do', tester: 'Creates and runs tests, files bugs', viewer: 'Read only' };
  const roleSelect = (cur) => `<select name="role">${['admin', 'tester', 'viewer'].map((r) => `<option value="${r}"${r === cur ? ' selected' : ''}>${r} — ${ROLE_HELP[r]}</option>`).join('')}</select>`;
  view.innerHTML = `
    <header class="head"><h1>Users</h1><button class="btn primary" data-act="add">${withIcon('plus', 'Add user')}</button></header>
    <section class="card flush"><table><thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.display_name)}</td><td class="muted">${esc(u.username)}</td><td class="muted">${esc(u.email || '—')}</td><td>${pill(u.role)}</td>
      <td>${u.active ? pill('Active') : pill('Inactive')}</td><td class="muted">${fmtDate(u.last_login)}</td>
      <td class="num"><button type="button" class="icon" data-act="edit" data-id="${u.id}" title="Edit ${esc(u.username)}" aria-label="Edit ${esc(u.username)}">${icon('pencil')}</button>
        <button type="button" class="icon" data-act="reset" data-id="${u.id}" title="Reset password" aria-label="Reset password for ${esc(u.username)}">${icon('key')}</button>
        <button type="button" class="icon" data-act="signout" data-id="${u.id}" title="Sign out everywhere" aria-label="Sign ${esc(u.username)} out everywhere">${icon('logout')}</button></td></tr>`).join('')}
    </tbody></table></section>
    <p class="muted">Users are deactivated, never deleted, so test runs and bugs keep showing who did what.</p>`;
  const done = async () => { await refreshUsers(); router(); };
  view.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const u = users.find((x) => x.id === Number(b.dataset.id));
    if (b.dataset.act === 'signout') {
      if (!confirm(`Sign ${u.username} out of every device? They can sign in again with their password.`)) return;
      api('POST', `/api/users/${u.id}/sign-out`, {}).then((r) => toast(`Ended ${r.count} session${r.count === 1 ? '' : 's'}`)).catch(fail);
      return;
    }
    if (b.dataset.act === 'add') {
      openDialog(`<h2>Add user</h2>
        <div class="two"><label>Username<input name="username" required maxlength="40" pattern="[A-Za-z0-9._\\-]{3,40}" autocomplete="off"></label><label>Name<input name="display_name" maxlength="80" autocomplete="off"></label></div>
        <label>Email<small>Optional. Needed for email notifications and password reset.</small><input name="email" type="email" maxlength="254" autocomplete="off"></label>
        <label>Role${roleSelect('tester')}</label>
        <label>Initial password<small>At least 8 characters. Share it securely; they can change it from their account menu.</small><input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Add user</button></footer>`,
        async (fd) => { await api('POST', '/api/users', Object.fromEntries(fd)); toast('User added'); await done(); });
    } else if (b.dataset.act === 'edit') {
      openDialog(`<h2>Edit ${esc(u.username)}</h2>
        <label>Name<input name="display_name" value="${esc(u.display_name)}" required maxlength="80"></label>
        <label>Email<input name="email" type="email" value="${esc(u.email || '')}" maxlength="254" autocomplete="off"></label>
        <label>Role${roleSelect(u.role)}</label>
        <label class="check"><input type="checkbox" name="active"${u.active ? ' checked' : ''}> Account is active <small>(inactive users cannot sign in)</small></label>
        ${u.totp ? `<p>${pill('On')} Two-factor sign-in. <button type="button" class="btn small ghost" data-reset2fa>Reset it</button> <small class="muted">for someone who lost their authenticator</small></p>` : ''}
        <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></footer>`,
        async (fd) => { await api('PUT', `/api/users/${u.id}`, { display_name: fd.get('display_name'), email: fd.get('email'), role: fd.get('role'), active: fd.get('active') === 'on' }); toast('User saved'); await done(); },
        (form) => {
          const b2 = form.querySelector('[data-reset2fa]');
          if (b2) b2.onclick = async () => {
            if (!confirm(`Switch off two-factor sign-in for ${u.username}? They can set it up again after signing in with their password.`)) return;
            try { await api('POST', `/api/users/${u.id}/2fa-reset`, {}); toast('Two-factor sign-in reset'); dlg.close(); await done(); } catch (err) { fail(err); }
          };
        });
    } else if (b.dataset.act === 'reset') {
      openDialog(`<h2>Reset password for ${esc(u.username)}</h2>
        <label>New password<small>They are signed out everywhere and must use this one.</small><input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Reset password</button></footer>`,
        async (fd) => { await api('PUT', `/api/users/${u.id}`, { password: fd.get('password') }); toast('Password reset'); });
    }
  };
}

// ---------- shell ----------
async function loadProjects() {
  STATE.projects = await api('GET', '/api/projects');
  const saved = Number(localStorage.getItem('pid'));
  STATE.pid = STATE.projects.some((p) => p.id === saved) ? saved : STATE.projects[0]?.id ?? null;
  $('#project').innerHTML = STATE.projects.map((p) => `<option value="${p.id}"${p.id === STATE.pid ? ' selected' : ''}>${esc(p.name)} (${esc(p.key)})</option>`).join('');
}
$('#project').onchange = (e) => {
  STATE.pid = Number(e.target.value);
  resetCasesUi();
  localStorage.setItem('pid', STATE.pid);
  if (location.hash && location.hash !== '#/') location.hash = '#/'; else router();
};
$('#new-project').onclick = () => openDialog(`
  <h2>New project</h2>
  <label>Name<input name="name" required maxlength="80" autofocus></label>
  <label>Key <small>short prefix for IDs, e.g. SHOP → SHOP-T1</small><input name="key" required pattern="[A-Za-z][A-Za-z0-9]{1,9}" maxlength="10"></label>
  <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Create project</button></footer>`,
  async (fd) => {
    const p = await api('POST', '/api/projects', { name: fd.get('name'), key: fd.get('key') });
    localStorage.setItem('pid', p.id);
    resetCasesUi();
    await loadProjects();
    location.hash = '#/';
    router();
  });

const ROUTES = [
  [/^#?\/?$/, 'dash', viewDashboard],
  [/^#\/cases$/, 'cases', viewCases],
  [/^#\/cases\/(new|\d+)$/, 'cases', viewCaseEdit],
  [/^#\/plans$/, 'plans', viewPlans],
  [/^#\/plans\/(\d+)$/, 'plans', viewPlan],
  [/^#\/cycles$/, 'cycles', viewCycles],
  [/^#\/cycles\/(\d+)$/, 'cycles', viewCycle],
  [/^#\/run\/(\d+)$/, 'cycles', viewRun],
  [/^#\/bugs$/, 'bugs', viewBugs],
  [/^#\/bugs\/(\d+)$/, 'bugs', viewBug],
  [/^#\/reports$/, 'reports', viewReports],
  [/^#\/trash$/, 'trash', viewTrash],
  [/^#\/webhooks$/, 'webhooks', viewWebhooks],
  [/^#\/sso$/, 'sso', viewSso],
  [/^#\/users$/, 'users', viewUsers],
  [/^#\/integrations$/, 'integrations', viewIntegrations],
  [/^#\/api-tokens$/, 'api-tokens', viewApiTokens],
  [/^#\/audit$/, 'audit', viewAudit],
  [/^#\/notifications$/, 'notifications', viewNotifications],
  [/^#\/custom-fields$/, 'custom-fields', viewCustomFields],
  [/^#\/email-settings$/, 'email-settings', viewEmailSettings],
];

async function router() {
  pasteHandler = keyHandler = null;
  view.onclick = view.onchange = view.oninput = view.ondrop = view.ondragover = null;
  view.ondragstart = view.ondragend = view.ondragleave = view.onkeydown = null;
  // A password-reset link, whether it opened a fresh tab or just changed the hash of one that was already open.
  const resetLink = /^#\/reset\/([\w-]+)$/.exec(location.hash);
  if (resetLink) {
    history.replaceState(null, '', location.pathname);
    if (STATE.user) toast('You are signed in. Sign out first to use a password reset link.', true); else renderReset(resetLink[1]);
    return;
  }
  if (!STATE.user) return;
  const hash = location.hash || '#/';
  const hit = ROUTES.find(([re]) => re.test(hash));
  if (!hit) { view.innerHTML = '<p class="empty">Page not found.</p>'; return; }
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === hit[1]));
  if ((hit[1] === 'users' || hit[1] === 'integrations' || hit[1] === 'api-tokens' || hit[1] === 'email-settings' || hit[1] === 'custom-fields' || hit[1] === 'audit') && STATE.user.role !== 'admin') { view.innerHTML = '<p class="empty">Only admins can open this page.</p>'; return; }
  if (!STATE.pid) { view.innerHTML = '<p class="empty">Create a project to get started.</p>'; return; }
  try { await hit[2](hit[0].exec(hash)[1]); }
  catch (e) { view.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
window.addEventListener('hashchange', router);
document.addEventListener('paste', (e) => {
  const files = imagesFrom(e.clipboardData && e.clipboardData.files);
  if (files.length && pasteHandler) { e.preventDefault(); pasteHandler(files); }
});
document.addEventListener('keydown', (e) => {
  if (!keyHandler || dlg.open || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, button, a')) return;
  keyHandler(e);
});

// ---------- overview ----------
async function viewDashboard() {
  const s = await api('GET', `/api/projects/${STATE.pid}/summary`);
  const t = s.totals;
  const done = t.pass + t.fail + t.blocked;
  const rate = done ? Math.round((t.pass / done) * 100) + '%' : '—';
  view.innerHTML = `
    <header class="head"><h1>Overview</h1></header>
    <section class="tiles">
      <a class="tile" href="#/cases"><b>${s.cases}</b><span>Test cases</span></a>
      <a class="tile" href="#/cycles"><b>${s.cycles}</b><span>Test cycles</span></a>
      <a class="tile" href="#/bugs"><b>${s.openBugs}</b><span>Open bugs</span></a>
      <div class="tile"><b>${rate}</b><span>Pass rate (${done} of ${t.total} executed)</span></div>
      <a class="tile" href="#/cycles"><b>${s.mine.runs}</b><span>Test runs assigned to you</span></a>
      <a class="tile" href="#/bugs"><b>${s.mine.bugs}</b><span>Open bugs assigned to you</span></a>
      ${s.overdueCycles ? `<a class="tile" href="#/cycles" data-overdue><b>${s.overdueCycles}</b><span>Overdue test cycle${s.overdueCycles === 1 ? '' : 's'}</span></a>` : ''}
      ${s.mine.reviews ? `<a class="tile" href="#/cases" data-review><b>${s.mine.reviews}</b><span>Test cases waiting for your review</span></a>` : ''}
    </section>
    <section class="card">
      <h2>Recent cycles</h2>
      ${s.recentCycles.length ? `<table><thead><tr><th>Cycle</th><th>Environment</th><th class="w-bar">Progress</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Left</th></tr></thead><tbody>
        ${s.recentCycles.map((c) => `<tr><td><a href="#/cycles/${c.id}"><span class="key">${esc(c.key)}</span> ${esc(c.name)}</a></td>
          <td>${c.adhoc ? '<span class="muted">Standalone</span>' : esc(c.environment)}</td><td>${bar(c)}</td><td class="num">${c.pass}</td><td class="num">${c.fail}</td><td class="num">${c.not_executed + c.in_progress}</td></tr>`).join('')}
        </tbody></table>` : '<p class="empty">No cycles yet. <a href="#/cycles">Create one</a> to start executing tests.</p>'}
    </section>
    <section class="card">
      <h2>Latest bugs</h2>
      ${s.recentBugs.length ? `<table><tbody>${s.recentBugs.map((b) => `<tr><td><a href="#/bugs/${b.id}"><span class="key">${esc(b.key)}</span> ${esc(b.title)}</a></td>
        <td>${pill(b.severity)}</td><td>${pill(b.status)}</td><td class="muted">${fmtDate(b.created_at)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No bugs filed. Fail a step during a run and press “Create bug”.</p>'}
    </section>`;
  view.onclick = (e) => {
    if (e.target.closest('[data-review]')) { CASES_UI.status = 'In Review'; CASES_UI.folder = ''; }
    if (e.target.closest('[data-overdue]')) { try { sessionStorage.setItem('cyfilter', 'overdue'); } catch { /* ignore */ } }
  };
}

// ---------- test cases ----------
async function runCase(caseId) {
  const r = await api('POST', `/api/cases/${caseId}/run`, {});
  location.hash = `#/run/${r.executionId}`;
}

const IMPORT_FIELDS = [
  ['title', 'Title (required)'], ['action', 'Step: action'], ['test_data', 'Step: test data'], ['expected', 'Step: expected result'],
  ['precondition', 'Preconditions'], ['objective', 'Objective'], ['folder', 'Folder'], ['priority', 'Priority'], ['status', 'Status'],
  ['labels', 'Labels'], ['links', 'Requirements (issue keys)'], ['automation_key', 'Automation key'],
  ['bdd_script', 'Gherkin (BDD) script'], ['params', 'Data sets (JSON)'],
  ['key', 'Source ID (tells cases apart; matches existing cases when updating)'],
];

function openImport(onDone) {
  let payload = null, parsed = null, mapping = {}, seq = 0, mode = 'create', strip = false;
  openDialog(`
    <h2>Import test cases</h2>
    <p class="muted">CSV or Excel (.xlsx). One row per step, with the test case fields on the first row of each case — the layout Zephyr Scale and most tools export.
      <a href="/api/import/template.csv" download>Download a template</a></p>
    <label>File<input type="file" name="file" accept=".csv,.tsv,.txt,.xlsx"></label>
    <div id="imp"></div>
    <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary" id="imp-go" disabled>Import</button></footer>`,
    async () => {
      const r = await api('POST', `/api/projects/${STATE.pid}/import`, { rows: parsed.rows, mapping, mode, stripHtml: strip });
      toast([r.created ? `Created ${r.created} test case${r.created === 1 ? '' : 's'}${r.firstKey ? ` (${esc(r.firstKey)}${r.created > 1 ? ' – ' + esc(r.lastKey) : ''})` : ''}` : '', r.updated ? `updated ${r.updated}` : '',
        r.ambiguous ? `${r.ambiguous} skipped (several matches)` : '', r.callsLinked ? `${r.callsLinked} reused-step link${r.callsLinked === 1 ? '' : 's'} restored` : '', r.callsUnresolved ? `${r.callsUnresolved} “Call test case” step${r.callsUnresolved === 1 ? '' : 's'} kept as text (case not found, or it would loop)` : '', r.keyConflicts ? `${r.keyConflicts} automation key${r.keyConflicts === 1 ? '' : 's'} already in use` : ''].filter(Boolean).join(', '));
      onDone();
    },
    (form) => {
      const box = $('#imp', form), go = $('#imp-go', form);
      const preview = async () => {
        const mine = ++seq;
        go.disabled = true;
        const out = $('#imp-prev', form);
        if (!(mapping.title >= 0)) { out.innerHTML = '<p class="warn">Choose the column that holds the test case title.</p>'; return; }
        try {
          const p = await api('POST', `/api/projects/${STATE.pid}/import`, { rows: parsed.rows, mapping, mode, stripHtml: strip, dryRun: true });
          if (mine !== seq) return;
          out.innerHTML = `<p>${mode === 'create' ? `<b>${p.cases}</b> test case${p.cases === 1 ? '' : 's'} with <b>${p.steps}</b> step${p.steps === 1 ? '' : 's'} will be created.`
            : `<b>${p.created}</b> will be created and <b>${p.updated}</b> updated${p.ambiguous ? `; <b>${p.ambiguous}</b> skipped because several test cases match` : ''} (the file has <b>${p.steps}</b> step${p.steps === 1 ? '' : 's'}).`}
            ${p.withoutSteps ? `${p.withoutSteps} ha${p.withoutSteps === 1 ? 's' : 've'} no steps.` : ''}
            ${p.skipped ? `${p.skipped} row${p.skipped === 1 ? '' : 's'} skipped (no title on or above them).` : ''}
            ${[p.withBdd && `${p.withBdd} Gherkin script${p.withBdd === 1 ? '' : 's'}`, p.withDataSets && `${p.withDataSets} with data sets`, p.calls && `${p.calls} “Call test case” step${p.calls === 1 ? '' : 's'}`].filter(Boolean).join(', ')}</p>
            ${p.preview.length ? `<table class="mini"><thead><tr><th>First test cases</th><th>Folder</th><th>Priority</th><th class="num">Steps</th><th>Result</th></tr></thead><tbody>
              ${p.preview.map((c) => `<tr><td>${esc(c.title)}</td><td>${esc(c.folder)}</td><td>${pill(c.priority)}</td><td class="num">${c.steps}</td><td>${c.action === 'update' ? `Update ${esc(c.target)}` : c.action === 'ambiguous' ? 'Skipped' : 'New'}</td></tr>`).join('')}</tbody></table>` : ''}`;
          go.disabled = !(p.created + p.updated);
        } catch (err) { if (mine === seq) out.innerHTML = `<p class="warn">${esc(err.message)}</p>`; }
      };
      const load = async (sheet) => {
        go.disabled = true;
        box.innerHTML = '<p class="muted">Reading file…</p>';
        try {
          parsed = await api('POST', '/api/import/parse', { ...payload, sheet });
          mapping = { ...parsed.mapping };
          strip = !!parsed.hasHtml;
          const cols = (f) => `<option value="-1">— not imported —</option>` + parsed.headers.map((h, i) => `<option value="${i}"${mapping[f] === i ? ' selected' : ''}>${esc(h)}</option>`).join('');
          box.innerHTML = `
            <p><b>${parsed.rows.length}</b> row${parsed.rows.length === 1 ? '' : 's'} found${parsed.truncated ? ' (file cut off at 10,000 rows)' : ''}.
              ${parsed.sheets.length > 1 ? `<label class="inline">Sheet <select data-sheet>${parsed.sheets.map((n, i) => `<option value="${i}"${i === parsed.sheet ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>` : ''}</p>
            <h3>Match columns</h3>
            <div class="mapgrid">${IMPORT_FIELDS.map(([f, label]) => `<label>${label}<select data-map="${f}">${cols(f)}</select></label>`).join('')}</div>
            <div class="two impopts"><label>If a test case already exists<select data-mode><option value="create">Always create new test cases</option><option value="update_id">Update the one with the same ID</option><option value="update_title">Update the one with the same title and folder</option></select></label>
              <label class="check"><input type="checkbox" data-html${strip ? ' checked' : ''}> Remove HTML formatting${parsed.hasHtml ? ' <small>(found in this file)</small>' : ''}</label></div>
            <div id="imp-prev"></div>`;
          await preview();
        } catch (err) { parsed = null; box.innerHTML = `<p class="warn">${esc(err.message)}</p>`; }
      };
      form.addEventListener('change', async (e) => {
        if (e.target.name === 'file') {
          const f = e.target.files[0];
          if (!f) return;
          if (f.size > 12 * 1024 * 1024) { box.innerHTML = '<p class="warn">File is larger than 12 MB.</p>'; return; }
          const p = await fileToPayload(f);
          payload = { filename: p.filename, data: p.data };
          await load();
        } else if (e.target.matches('[data-sheet]')) await load(Number(e.target.value));
        else if (e.target.matches('[data-mode]')) { mode = e.target.value; await preview(); }
        else if (e.target.matches('[data-html]')) { strip = e.target.checked; await preview(); }
        else if (e.target.matches('[data-map]')) {
          const v = Number(e.target.value);
          if (v >= 0) mapping[e.target.dataset.map] = v; else delete mapping[e.target.dataset.map];
          await preview();
        }
      });
    });
}

function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

// scopes: [{ label, params }] — radio choices appended to the export URL as query parameters.
function openExport({ title, base, scopes = [], note = '' }) {
  openDialog(`<h2>${esc(title)}</h2>
    <label>Format<select name="format"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (.csv)</option></select></label>
    ${scopes.length ? `<fieldset><legend>What to export</legend>${scopes.map((s, i) => `<label class="radio"><input type="radio" name="scope" value="${i}"${i ? '' : ' checked'}> <span>${esc(s.label)}</span></label>`).join('')}</fieldset>` : ''}
    ${note ? `<p class="muted">${esc(note)}</p>` : ''}
    <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${withIcon('download', 'Download')}</button></footer>`,
    async (fd) => {
      const sc = scopes[Number(fd.get('scope'))];
      download(`${base}?format=${encodeURIComponent(fd.get('format'))}${sc && sc.params ? '&' + sc.params : ''}`);
    });
}

// ----- folder tree -----
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const inFolder = (cf, folder, deep) => (folder === '' ? deep || cf === '' : cf === folder || (deep && cf.startsWith(folder + '/')));
const folderList = (folders) => `<datalist id="dl-folders">${folders.map((f) => `<option value="${esc(f)}"></option>`).join('')}</datalist>`;

function buildTree(folders, cases) {
  const counts = new Map(), kids = new Map();
  for (const c of cases) {
    let p = c.folder;
    for (;;) { counts.set(p, (counts.get(p) || 0) + 1); if (!p) break; p = parentOf(p); }
  }
  for (const p of folders) {
    const par = parentOf(p);
    if (!kids.has(par)) kids.set(par, []);
    kids.get(par).push(p);
  }
  for (const l of kids.values()) l.sort((a, b) => baseName(a).localeCompare(baseName(b), undefined, { numeric: true, sensitivity: 'base' }));
  return { counts, kids };
}

function treeHtml(tree) {
  const node = (path, depth) => {
    const kids = tree.kids.get(path) || [];
    const open = !CASES_UI.collapsed.has(path);
    const on = CASES_UI.folder === path;
    return `<li role="treeitem" aria-selected="${on}"${kids.length ? ` aria-expanded="${open}"` : ''}>
      <div class="node${on ? ' on' : ''}" data-path="${esc(path)}" style="--d:${depth}">
        ${kids.length ? `<button type="button" class="tw" data-act="toggle" data-path="${esc(path)}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(baseName(path))}">${icon(open ? 'chevron-down' : 'chevron-right')}</button>` : '<span class="tw"></span>'}
        <button type="button" class="nl" data-act="pick" data-path="${esc(path)}">${icon('folder')}<span class="nm">${esc(baseName(path))}</span><span class="ct">${tree.counts.get(path) || 0}</span></button>
      </div>
      ${kids.length && open ? `<ul role="group">${kids.map((k) => node(k, depth + 1)).join('')}</ul>` : ''}</li>`;
  };
  const top = tree.kids.get('') || [];
  const rootOn = CASES_UI.folder === '';
  return `<li role="treeitem" aria-selected="${rootOn}">
    <div class="node root${rootOn ? ' on' : ''}" data-path="" style="--d:0"><span class="tw"></span>
      <button type="button" class="nl" data-act="pick" data-path="">${icon('list')}<span class="nm">All test cases</span><span class="ct">${tree.counts.get('') || 0}</span></button></div>
    ${top.length ? `<ul role="group">${top.map((k) => node(k, 1)).join('')}</ul>` : ''}</li>`;
}

async function viewCases() {
  const U = CASES_UI;
  let cases = [], folders = [];
  const load = async () => {
    [cases, folders] = await Promise.all([api('GET', `/api/projects/${STATE.pid}/cases`), api('GET', `/api/projects/${STATE.pid}/folders`)]);
    const ids = new Set(cases.map((c) => c.id));
    for (const id of [...U.sel]) if (!ids.has(id)) U.sel.delete(id);
    if (U.folder && !folders.includes(U.folder)) U.folder = '';
  };
  await load();
  const visible = () => {
    const t = U.term.toLowerCase();
    return cases.filter((c) => inFolder(c.folder, U.folder, U.deep) && (!U.status || c.status === U.status) && (!t || `${c.key} ${c.title} ${c.labels} ${c.refs || ''} ${c.automation_key || ''}`.toLowerCase().includes(t)));
  };
  const row = (c) => `<tr draggable="true" data-id="${c.id}"${U.sel.has(c.id) ? ' class="picked"' : ''}>
    <td class="cb"><input type="checkbox" data-sel="${c.id}"${U.sel.has(c.id) ? ' checked' : ''} aria-label="Select ${esc(c.key)}"></td>
    <td><a href="#/cases/${c.id}"><span class="key">${esc(c.key)}</span> ${esc(c.title)}</a>${c.automation_key ? ` <span class="chip ext auto" title="Automation key: ${esc(c.automation_key)}">Automated</span>` : ''}</td>
    <td>${esc(c.folder)}</td><td>${pill(c.priority)}</td><td>${pill(c.status)}</td><td class="num">${c.script_type === 'bdd' ? 'Gherkin' : c.step_count}</td>
    <td>${c.last_status ? pill(c.last_status) : '<span class="muted">Never run</span>'}</td>
    <td class="num">${c.open_bugs || ''}</td>
    <td class="num"><button type="button" class="btn small ghost" data-act="run" data-id="${c.id}" title="Run this test case on its own">${withIcon('play', 'Run')}</button></td></tr>`;

  view.innerHTML = `
    <header class="head"><h1>Test cases</h1><span>
      <button type="button" class="btn ghost" data-act="import">${withIcon('upload', 'Import')}</button>
      <button type="button" class="btn ghost" data-act="export">${withIcon('download', 'Export')}</button>
      <a class="btn primary" href="#/cases/new">${withIcon('plus', 'New test case')}</a></span></header>
    <div class="split">
      <aside class="card tree-pane" aria-label="Folders"><h2>Folders</h2><ul id="tree" class="tree" role="tree"></ul></aside>
      <section class="cases-pane">
        <div class="fbar" id="fbar"></div>
        <div class="filters"><input type="search" id="q" placeholder="Search by key, title, label or requirement" aria-label="Search test cases">
          <label class="check"><input type="checkbox" id="deep"> Include subfolders</label>
          <select id="status-filter" aria-label="Status"><option value="">Any status</option>${['Draft', 'In Review', 'Approved', 'Deprecated'].map((s) => `<option>${s}</option>`).join('')}</select>
          <span class="viewsbar" id="viewsbar"></span></div>
        <div class="bulk" id="bulk" hidden></div>
        <section class="card flush"><table><thead><tr><th class="cb"><input type="checkbox" id="sel-all" aria-label="Select all shown"></th><th>Test case</th><th>Folder</th><th>Priority</th><th>Status</th><th class="num">Steps</th><th>Last result</th><th class="num">Open bugs</th><th></th></tr></thead>
        <tbody id="rows"></tbody></table></section>
      </section>
    </div>`;
  $('#q').value = U.term;
  $('#deep').checked = U.deep;
  $('#status-filter').value = U.status;
  mountViews($('#viewsbar'), 'cases', () => ({ term: U.term, status: U.status, folder: U.folder, deep: U.deep }),
    (st) => { Object.assign(U, { term: st.term || '', status: st.status || '', folder: st.folder || '', deep: st.deep !== false }); U.sel.clear(); router(); });

  const paint = () => {
    const list = visible();
    $('#tree').innerHTML = treeHtml(buildTree(folders, cases));
    $('#fbar').innerHTML = `<span class="fname">${icon('folder')}<strong>${U.folder ? esc(U.folder) : 'All test cases'}</strong><span class="muted">${list.length} test case${list.length === 1 ? '' : 's'}</span></span>
      <span class="fbtns"><button type="button" class="btn small ghost" data-act="new-folder">${withIcon('folder-plus', U.folder ? 'New subfolder' : 'New folder')}</button>
      ${U.folder ? `<button type="button" class="btn small ghost" data-act="rename-folder">${withIcon('pencil', 'Rename / move')}</button>
        <button type="button" class="btn small danger" data-act="delete-folder">${withIcon('trash', 'Delete folder')}</button>` : ''}</span>`;
    const n = U.sel.size;
    $('#bulk').hidden = !n;
    $('#bulk').innerHTML = n ? `<strong>${n} selected</strong>
      <button type="button" class="btn small ghost" data-act="bulk-edit">${withIcon('pencil', 'Edit…')}</button>
      <button type="button" class="btn small ghost" data-act="bulk-move">${withIcon('move', 'Move to folder')}</button>
      <button type="button" class="btn small ghost" data-act="bulk-export">${withIcon('download', 'Export')}</button>
      <button type="button" class="btn small danger" data-act="bulk-delete">${withIcon('trash', 'Delete')}</button>
      <button type="button" class="btn small ghost" data-act="bulk-clear">${withIcon('x', 'Clear')}</button>` : '';
    $('#rows').innerHTML = list.length ? list.map(row).join('')
      : `<tr><td colspan="9" class="empty">${cases.length ? 'No test cases here.' : 'No test cases yet. Create one or import a CSV / Excel file.'}</td></tr>`;
    const all = $('#sel-all'), picked = list.filter((c) => U.sel.has(c.id)).length;
    all.checked = !!list.length && picked === list.length;
    all.indeterminate = picked > 0 && picked < list.length;
  };
  const refresh = async () => { await load(); paint(); };
  const moveCases = async (ids, folder) => {
    const r = await api('POST', `/api/projects/${STATE.pid}/cases/bulk`, { ids, action: 'move', folder });
    U.sel.clear();
    await refresh();
    toast(`Moved ${r.count} test case${r.count === 1 ? '' : 's'} to ${esc(folder.trim() || 'no folder')}`);
  };
  const expand = (path) => { for (let p = parentOf(path); p; p = parentOf(p)) U.collapsed.delete(p); };
  const pathDialog = ({ title, label, hint, value, required = true, cta = 'Save' }, submit) => openDialog(`<h2>${esc(title)}</h2>
      <label>${esc(label)}<small>${esc(hint)}</small><input name="path" ${required ? 'required' : ''} maxlength="300" value="${esc(value)}" list="dl-folders" autocomplete="off"></label>${folderList(folders)}
      <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${esc(cta)}</button></footer>`,
    async (fd) => submit(String(fd.get('path'))),
    (form) => { const i = form.elements.path; i.focus(); i.setSelectionRange(i.value.length, i.value.length); });
  const exportDialog = () => {
    const scopes = [];
    if (U.sel.size) scopes.push({ label: `Selected test cases (${U.sel.size})`, params: `ids=${[...U.sel].join(',')}` });
    if (U.folder) {
      const n = cases.filter((c) => inFolder(c.folder, U.folder, U.deep)).length;
      scopes.push({ label: `Folder “${U.folder}”${U.deep ? ' and its subfolders' : ''} (${n})`, params: `folder=${encodeURIComponent(U.folder)}&deep=${U.deep ? 1 : 0}` });
    }
    scopes.push({ label: `All test cases (${cases.length})`, params: '' });
    openExport({ title: 'Export test cases', base: `/api/projects/${STATE.pid}/export`, scopes, note: 'One row per step. The file can be imported again.' });
  };

  view.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    try {
      if (act === 'pick') { U.folder = b.dataset.path; U.sel.clear(); paint(); }
      else if (act === 'toggle') { const p = b.dataset.path; if (U.collapsed.has(p)) U.collapsed.delete(p); else U.collapsed.add(p); paint(); }
      else if (act === 'run') await runCase(b.dataset.id);
      else if (act === 'import') openImport(() => refresh().catch(fail));
      else if (act === 'export' || act === 'bulk-export') exportDialog();
      else if (act === 'new-folder') {
        pathDialog({ title: U.folder ? `New subfolder in ${U.folder}` : 'New folder', label: 'Folder path', hint: 'Use / to nest, e.g. Checkout/Payments', value: U.folder ? U.folder + '/' : '', cta: 'Create folder' },
          async (path) => { const r = await api('POST', `/api/projects/${STATE.pid}/folders`, { path }); expand(r.path); U.folder = r.path; U.sel.clear(); await refresh(); });
      } else if (act === 'rename-folder') {
        pathDialog({ title: `Rename or move “${U.folder}”`, label: 'New path', hint: 'Change the last part to rename it, or the whole path to move the folder with everything in it.', value: U.folder },
          async (path) => { const r = await api('POST', `/api/projects/${STATE.pid}/folders/rename`, { from: U.folder, to: path }); expand(r.path); U.folder = r.path; await refresh(); });
      } else if (act === 'delete-folder') {
        const n = cases.filter((c) => inFolder(c.folder, U.folder, true)).length;
        if (!confirm(`Delete folder “${U.folder}”?\n\nNo test cases are deleted. ${n ? `Its ${n} test case${n === 1 ? '' : 's'} and any subfolders move up one level.` : 'It is empty.'}`)) return;
        const r = await api('POST', `/api/projects/${STATE.pid}/folders/delete`, { path: U.folder });
        U.folder = r.path;
        U.sel.clear();
        await refresh();
      } else if (act === 'bulk-edit') {
        const n = U.sel.size;
        openDialog(`<h2>Edit ${n} test case${n === 1 ? '' : 's'}</h2><p class="muted">Only what you choose changes. Each change is saved as a new version.</p>
          <div class="two"><label>Priority<select name="priority"><option value="">Leave as it is</option>${['High', 'Medium', 'Low'].map((o) => `<option>${o}</option>`).join('')}</select></label>
            <label>Status<select name="status"><option value="">Leave as it is</option>${['Draft', 'In Review', 'Approved', 'Deprecated'].map((o) => `<option>${o}</option>`).join('')}</select></label></div>
          <div class="two"><label>Labels<select name="mode"><option value="">Leave as they are</option><option value="add">Add these labels</option><option value="remove">Remove these labels</option><option value="set">Replace all labels with</option></select></label>
            <label>Label list<input name="labels" placeholder="smoke, ui" aria-describedby="lh"></label></div><p class="muted" id="lh">Separate labels with commas.</p>
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Apply to ${n}</button></footer>`,
          async (fd) => {
            const fields = {};
            if (fd.get('priority')) fields.priority = fd.get('priority');
            if (fd.get('status')) fields.status = fd.get('status');
            if (fd.get('mode')) fields.labels = { mode: fd.get('mode'), value: fd.get('labels') };
            const r = await api('POST', `/api/projects/${STATE.pid}/cases/bulk`, { ids: [...U.sel], action: 'update', fields });
            toast(`Updated ${r.count} test case${r.count === 1 ? '' : 's'}`);
            await refresh();
          });
      } else if (act === 'bulk-move') {
        pathDialog({ title: `Move ${U.sel.size} test case${U.sel.size === 1 ? '' : 's'}`, label: 'Folder path', hint: 'Pick an existing folder or type a new path. Leave empty to remove the folder.', value: U.folder, required: false, cta: 'Move' },
          (path) => moveCases([...U.sel], path));
      } else if (act === 'bulk-delete') {
        const n = U.sel.size;
        if (!confirm(`Delete ${n} test case${n === 1 ? '' : 's'}? They move to Trash, where you can restore them. Past executions and bugs are kept.`)) return;
        const r = await api('POST', `/api/projects/${STATE.pid}/cases/bulk`, { ids: [...U.sel], action: 'delete' });
        U.sel.clear();
        await refresh();
        toast(`${n} test case${n === 1 ? '' : 's'} moved to Trash. <a href="#/trash">Open Trash</a>`, false, 8000);
      } else if (act === 'bulk-clear') { U.sel.clear(); paint(); }
    } catch (err) { fail(err); }
  };
  view.oninput = (e) => { if (e.target.id === 'q') { U.term = e.target.value; paint(); } };
  view.onchange = (e) => {
    const t = e.target;
    if (t.id === 'deep') { U.deep = t.checked; paint(); }
    else if (t.id === 'status-filter') { U.status = t.value; paint(); }
    else if (t.id === 'sel-all') { for (const c of visible()) { if (t.checked) U.sel.add(c.id); else U.sel.delete(c.id); } paint(); }
    else if (t.matches('[data-sel]')) { const id = Number(t.dataset.sel); if (t.checked) U.sel.add(id); else U.sel.delete(id); paint(); }
  };

  // Drag test cases onto a folder in the tree to move them.
  let dragIds = null;
  view.ondragstart = (e) => {
    const tr = e.target.closest && e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = Number(tr.dataset.id);
    dragIds = U.sel.has(id) ? [...U.sel] : [id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${dragIds.length} test case${dragIds.length === 1 ? '' : 's'}`);
  };
  view.ondragend = () => { dragIds = null; $$('.node.drop', view).forEach((n) => n.classList.remove('drop')); };
  view.ondragover = (e) => {
    const n = dragIds && e.target.closest('.node');
    if (!n) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    n.classList.add('drop');
  };
  view.ondragleave = (e) => {
    const n = e.target.closest && e.target.closest('.node');
    if (n && !n.contains(e.relatedTarget)) n.classList.remove('drop');
  };
  view.ondrop = (e) => {
    const n = dragIds && e.target.closest('.node');
    if (!n) return;
    e.preventDefault();
    const ids = dragIds;
    dragIds = null;
    n.classList.remove('drop');
    moveCases(ids, n.dataset.path).catch(fail);
  };
  paint();
}

async function viewCaseEdit(id) {
  const isNew = id === 'new';
  const folders = await api('GET', `/api/projects/${STATE.pid}/folders`);
  const history = isNew ? [] : await api('GET', `/api/cases/${id}/versions`);
  const allCases = (await api('GET', `/api/projects/${STATE.pid}/cases`)).filter((x) => String(x.id) !== String(id));
  const cfDefs = await api('GET', `/api/projects/${STATE.pid}/fields?entity=case`);
  const c = isNew
    ? { title: '', objective: '', precondition: '', priority: 'Medium', status: 'Draft', folder: CASES_UI.folder, labels: '', steps: [{}], bugs: [], runs: [], usedBy: [], links: [], fields: {}, script_type: 'steps', bdd_script: '', params: { columns: [], rows: [] } }
    : await api('GET', `/api/cases/${id}`);
  let steps = c.steps.length ? c.steps.map((s) => ({ ...s })) : [{}];
  let params = { columns: [...c.params.columns], rows: c.params.rows.map((r) => [...r]) };
  let links = c.links.map((l) => ({ ...l }));
  let scriptType = c.script_type || 'steps';
  const me = STATE.user;
  const reviewBanner = () => {
    if (isNew) return '';
    if (c.status === 'In Review') {
      const decide = me.id === c.reviewer_id || me.role === 'admin';
      return `<section class="card banner"><p><b>In review</b> by ${esc(c.reviewer_name || 'someone')}${c.review_note ? ` · “${esc(c.review_note)}”` : ''}</p>
        <p class="rowbtns">${decide ? `<button type="button" class="btn primary small" data-act="approve">${withIcon('check', 'Approve')}</button> <button type="button" class="btn ghost small" data-act="reject">${withIcon('x', 'Request changes')}</button>` : '<span class="muted">Waiting for the reviewer.</span>'}
        ${me.id === c.review_requested_by || me.role === 'admin' ? `<button type="button" class="btn ghost small" data-act="withdraw">Withdraw</button>` : ''}</p></section>`;
    }
    if (c.status === 'Approved' && c.approved_by_name) return `<section class="card banner ok"><p><b>Approved</b> by ${esc(c.approved_by_name)} on ${fmtDate(c.approved_at)}${c.review_note ? ` · “${esc(c.review_note)}”` : ''}</p></section>`;
    if (c.status === 'Draft' && c.review_note) return `<section class="card banner warnbox"><p><b>Changes were requested:</b> ${esc(c.review_note)}</p></section>`;
    return '';
  };
  const linksHtml = () => (links.length ? `<p class="links">${links.map((l, i) => `<span class="chip ext">${l.href ? `<a href="${esc(safeUrl(l.href))}" target="_blank" rel="noopener noreferrer">${icon('link')}<span>${esc(l.ref)}</span></a>` : `${icon('link')}<span>${esc(l.ref)}</span>`}${l.title ? `<small>${esc(l.title)}</small>` : ''}<button type="button" class="x" data-act="del-link" data-i="${i}" aria-label="Remove ${esc(l.ref)}" title="Remove">${icon('x')}</button></span>`).join('')}</p>` : '<p class="muted">Not linked to any requirement yet.</p>');

  const toolButtons = (i) => `<span class="tools">
        <button type="button" class="icon" data-act="up" title="Move up" aria-label="Move step up"${i ? '' : ' disabled'}>${icon('up')}</button>
        <button type="button" class="icon" data-act="down" title="Move down" aria-label="Move step down"${i < steps.length - 1 ? '' : ' disabled'}>${icon('down')}</button>
        <button type="button" class="icon danger" data-act="del" title="Remove step" aria-label="Remove step">${icon('trash')}</button>
      </span>`;
  const stepRows = () => steps.map((s, i) => (s.call_case_id !== undefined && s.call_case_id !== null ? `<div class="steprow call" data-i="${i}">
      <span class="n">${i + 1}</span>
      <div class="callbox"><label>Call test case<select data-f="call_case_id" aria-label="Test case to call for step ${i + 1}"><option value="0">Choose a test case…</option>${allCases.map((x) => `<option value="${x.id}"${x.id === s.call_case_id ? ' selected' : ''}>${esc(x.key)} ${esc(x.title)}</option>`).join('')}</select></label>
        ${s.call_case_id ? `<span class="muted">its steps run here · <a href="#/cases/${s.call_case_id}">open</a></span>` : '<span class="muted">its steps run here, tagged with its key</span>'}</div>
      ${toolButtons(i)}</div>` : `<div class="steprow" data-i="${i}">
      <span class="n">${i + 1}</span>
      <textarea data-f="action" rows="2" placeholder="What the tester does" aria-label="Step ${i + 1} action">${esc(s.action)}</textarea>
      <textarea data-f="test_data" rows="2" placeholder="Test data (optional)" aria-label="Step ${i + 1} test data">${esc(s.test_data)}</textarea>
      <textarea data-f="expected" rows="2" placeholder="What should happen" aria-label="Step ${i + 1} expected result">${esc(s.expected)}</textarea>
      ${toolButtons(i)}</div>`)).join('');
  const sync = () => $$('.steprow', view).forEach((row) => {
    const s = steps[Number(row.dataset.i)];
    $$('textarea', row).forEach((t) => { s[t.dataset.f] = t.value; });
    const sel = $('select[data-f=call_case_id]', row);
    if (sel) s.call_case_id = Number(sel.value);
  });
  const syncParams = () => {
    $$('[data-col]', view).forEach((i) => { params.columns[Number(i.dataset.col)] = i.value; });
    $$('[data-cell]', view).forEach((i) => { const [r, c] = i.dataset.cell.split(':').map(Number); params.rows[r][c] = i.value; });
  };
  const paramsHtml = () => `<p class="muted">Use <code>{{column}}</code> in steps and preconditions. The test case then runs once for every row, with the values filled in.</p>
    ${params.columns.length ? `<div class="tscroll"><table class="datagrid"><thead><tr><th class="rn"></th>${params.columns.map((col, j) => `<th><span class="colhead"><input data-col="${j}" value="${esc(col)}" placeholder="column name" maxlength="40" aria-label="Column ${j + 1} name"><button type="button" class="icon small danger" data-act="del-col" data-j="${j}" title="Remove column" aria-label="Remove column ${j + 1}">${icon('x')}</button></span></th>`).join('')}<th></th></tr></thead>
      <tbody>${params.rows.map((r, i) => `<tr><td class="rn">${i + 1}</td>${params.columns.map((col, j) => `<td><input data-cell="${i}:${j}" value="${esc(r[j] ?? '')}" aria-label="Row ${i + 1}, ${esc(col)}"></td>`).join('')}<td><button type="button" class="icon small" data-act="del-row" data-i="${i}" title="Remove row" aria-label="Remove row ${i + 1}">${icon('trash')}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No data sets. Add a column to start.</p>'}
    <p class="rowbtns"><button type="button" class="btn ghost small" data-act="add-col">${withIcon('plus', 'Add column')}</button>
      ${params.columns.length ? `<button type="button" class="btn ghost small" data-act="add-row">${withIcon('plus', 'Add row')}</button>` : ''}
      <button type="button" class="btn ghost small" data-act="paste-data">${withIcon('upload', 'Paste from a spreadsheet')}</button>${params.columns.length ? ` <span class="muted">${params.rows.length} row${params.rows.length === 1 ? '' : 's'} = ${params.rows.length || 1} run${params.rows.length > 1 ? 's' : ''}</span>` : ''}</p>`;

  view.innerHTML = `
    <header class="head"><h1>${isNew ? 'New test case' : `<span class="key">${esc(c.key)}</span> Edit test case`}</h1>
      <span>${isNew ? '' : `<button class="btn danger" data-act="delete">${withIcon('trash', 'Delete')}</button> ${c.status === 'Draft' ? `<button class="btn ghost" data-act="request-review">${withIcon('check', 'Request review')}</button> ` : ''}<button class="btn ghost" data-act="clone">${withIcon('copy', 'Clone')}</button> <button class="btn ghost" data-act="run" title="Run the last saved version on its own">${withIcon('play', 'Run')}</button>`}
      <a class="btn ghost" href="#/cases">Cancel</a> <button class="btn primary" data-act="save">${withIcon('save', 'Save')}</button></span></header>
    ${reviewBanner()}
    ${isNew ? '' : `<p class="meta">Version ${c.version}${c.updated_by_name ? ` · last edited by ${esc(c.updated_by_name)}` : ''} on ${fmtDate(c.updated_at)}${c.created_by_name ? ` · created by ${esc(c.created_by_name)}` : ''}</p>`}
    <section class="card form">
      <label class="wide">Title<input id="f-title" value="${esc(c.title)}" maxlength="200" required></label>
      <label>Folder<input id="f-folder" value="${esc(c.folder)}" placeholder="e.g. Checkout/Payments" list="dl-folders" autocomplete="off"></label>${folderList(folders)}
      <label>Labels<input id="f-labels" value="${esc(c.labels)}" placeholder="comma separated"></label>
      <label>Automation key<small>How a CI test is matched to this case</small><input id="f-automation_key" value="${esc(c.automation_key)}" placeholder="e.g. tests/login.spec.ts::signs in" maxlength="300" autocomplete="off" spellcheck="false"></label>
      <label>Priority<select id="f-priority">${options(['High', 'Medium', 'Low'], c.priority)}</select></label>
      <label>Status<select id="f-status">${options(['Draft', 'In Review', 'Approved', 'Deprecated'], c.status)}</select></label>
      <label class="wide">Objective<textarea id="f-objective" rows="2">${esc(c.objective)}</textarea></label>
      <label class="wide">Preconditions<textarea id="f-precondition" rows="2">${esc(c.precondition)}</textarea></label>
    </section>
    ${cfDefs.length ? `<section class="card form" id="cf-card">${fieldInputs(cfDefs, c.fields, 'cf')}</section>` : ''}
    <section class="card" id="steps-card">
      <div class="chart-head"><h2>Test script</h2><div class="seg-toggle" role="group" aria-label="Script type"><button type="button" data-script="steps" aria-pressed="${scriptType === 'steps'}">Step by step</button><button type="button" data-script="bdd" aria-pressed="${scriptType === 'bdd'}">Gherkin (BDD)</button></div></div>
      <div id="bdd-box"${scriptType === 'bdd' ? '' : ' hidden'}>
        <p class="muted">One scenario per test case. Each Given / When / Then / And line becomes a step to execute. A <code>Scenario Outline</code> with an <code>Examples</code> table becomes the data sets.</p>
        <textarea id="f-bdd" class="mono" rows="14" spellcheck="false" placeholder="Feature: Login&#10;  Scenario: Sign in&#10;    Given a registered user&#10;    When they sign in with the right password&#10;    Then they see their dashboard">${esc(c.bdd_script || '')}</textarea>
        ${c.script_type === 'bdd' && c.bdd_steps ? `<h3>Steps as they will be run</h3><ol class="bddsteps">${c.bdd_steps.map((s) => `<li><span class="pre">${esc(s.action)}</span></li>`).join('')}</ol>${c.bdd_examples ? `<p class="muted">${c.bdd_examples.rows.length} example row${c.bdd_examples.rows.length === 1 ? '' : 's'} = ${c.bdd_examples.rows.length} run${c.bdd_examples.rows.length === 1 ? '' : 's'}</p>` : ''}` : ''}
      </div>
      <div id="steps-box"${scriptType === 'steps' ? '' : ' hidden'}>
      <div class="steprow hdr"><span></span><b>Action</b><b>Test data</b><b>Expected result</b><span></span></div>
      <div id="steps">${stepRows()}</div>
      <p class="rowbtns"><button type="button" class="btn ghost" data-act="add">${withIcon('plus', 'Add step')}</button>
        <button type="button" class="btn ghost" data-act="add-call">${withIcon('link', 'Call another test case')}</button></p>
      </div>
    </section>
    <section class="card"><h2>Requirements covered</h2>
      <p class="muted">Link this test case to the requirements it verifies: a Jira key such as PROJ-123, #45 for a GitHub issue, or any name. Reports show which requirements are covered and how they last ran.</p>
      <div id="links">${linksHtml()}</div>
      <div class="addlink"><input id="l-ref" placeholder="PROJ-123" maxlength="100" aria-label="Requirement key or name"><input id="l-title" placeholder="Title (optional)" maxlength="200" aria-label="Requirement title">
        <input id="l-url" placeholder="Link (optional, https://…)" maxlength="500" aria-label="Requirement link"><button type="button" class="btn ghost" data-act="add-link">${withIcon('plus', 'Add')}</button></div></section>
    <section class="card" id="params-card"${scriptType === 'bdd' ? ' hidden' : ''}><h2>Data sets</h2><div id="params">${paramsHtml()}</div></section>
    ${c.usedBy.length ? `<section class="card"><h2>Used by</h2><p class="muted">These test cases call this one, so changes here apply to their future runs.</p><p>${c.usedBy.map((u) => `<a class="chip ext" href="#/cases/${u.id}"><span>${esc(u.key)} ${esc(u.title)}</span></a>`).join(' ')}</p></section>` : ''}
    ${c.bugs.length ? `<section class="card"><h2>Bugs found by this test</h2><table><tbody>${c.bugs.map((b) => `<tr>
      <td><a href="#/bugs/${b.id}"><span class="key">${esc(b.key)}</span> ${esc(b.title)}</a></td><td>${pill(b.severity)}</td><td>${pill(b.status)}</td></tr>`).join('')}</tbody></table></section>` : ''}
    ${c.runs.length ? `<section class="card"><h2>Run history</h2>${c.runStats && c.runStats.runs ? `<p class="muted">${c.runStats.runs} decided run${c.runStats.runs === 1 ? '' : 's'}: ${c.runStats.fails} failed${c.runStats.switches >= 2 ? `, switched between pass and fail ${c.runStats.switches} times (possibly flaky)` : ''}${c.runStats.avg_ms ? `. Average time ${fmtMs(c.runStats.avg_ms)}` : ''}.</p>` : ''}<table><tbody>${c.runs.map((r) => `<tr>
      <td><a href="#/run/${r.id}">${r.adhoc ? 'Standalone run' : `<span class="key">${esc(r.cycle_key)}</span> ${esc(r.cycle_name)}`}</a></td>
      <td>${pill(r.status)}</td><td class="muted">${fmtDate(r.executed_at)}</td><td class="num muted">${fmtMs(r.duration_ms)}</td></tr>`).join('')}</tbody></table></section>` : ''}
    ${isNew ? '' : '<section class="card" id="discuss"></section>'}
    ${isNew ? '' : `<section class="card"><h2>Version history</h2>
      <div class="tscroll"><table><thead><tr><th>Version</th><th>Saved</th><th>By</th><th>Note</th><th></th></tr></thead><tbody>
      ${history.map((h, i) => `<tr><td><b>v${h.version}</b>${i === 0 ? ' <span class="pill active">Current</span>' : ''}</td><td>${fmtDate(h.created_at)}</td><td>${esc(h.author || '—')}</td><td class="muted">${esc(h.note)}</td>
        <td class="num">${i === 0 ? '' : `<button type="button" class="btn small ghost" data-act="compare" data-v="${h.version}">Compare</button> <button type="button" class="btn small ghost" data-act="restore" data-v="${h.version}">${withIcon('rotate', 'Restore')}</button>`}</td></tr>`).join('')}
      </tbody></table></div></section>`}`;

  if (!isNew) mountDiscussion($('#discuss'), 'case', id, c);
  view.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.closest('.addlink')) { e.preventDefault(); $('[data-act=add-link]').click(); }
  };
  view.onclick = async (e) => {
    const b = e.target.closest('[data-act], [data-script]');
    if (!b) return;
    const act = b.dataset.act;
    const row = b.closest('.steprow');
    const i = row ? Number(row.dataset.i) : -1;
    try {
      if (act === 'request-review') {
        openDialog(`<h2>Request review</h2><p class="muted">The reviewer is notified and can approve ${esc(c.key)} or ask for changes.</p>
          <label>Reviewer<select name="reviewer_id" required><option value="">Choose…</option>${STATE.users.filter((u) => u.id !== me.id).map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join('')}</select></label>
          <label>Note for the reviewer <small>(optional)</small><textarea name="note" rows="3" maxlength="2000"></textarea></label>
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Send for review</button></footer>`,
          async (fd) => { await api('POST', `/api/cases/${id}/review`, { action: 'request', reviewer_id: Number(fd.get('reviewer_id')), note: fd.get('note') }); toast('Sent for review'); router(); });
      } else if (act === 'approve' || act === 'reject') {
        const ok = act === 'approve';
        openDialog(`<h2>${ok ? 'Approve' : 'Request changes to'} ${esc(c.key)}</h2>
          <label>${ok ? 'Note <small>(optional)</small>' : 'What needs to change?'}<textarea name="note" rows="4" maxlength="2000"${ok ? '' : ' required'}></textarea></label>
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${ok ? 'Approve' : 'Send back to the author'}</button></footer>`,
          async (fd) => { await api('POST', `/api/cases/${id}/review`, { action: act, note: fd.get('note') }); toast(ok ? 'Approved' : 'Sent back for changes'); router(); });
      } else if (act === 'withdraw') {
        await api('POST', `/api/cases/${id}/review`, { action: 'withdraw' }); toast('Review withdrawn'); router();
      } else if (b.dataset.script) {
        scriptType = b.dataset.script;
        $$('[data-script]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('#bdd-box').hidden = scriptType !== 'bdd'; $('#steps-box').hidden = scriptType !== 'steps'; $('#params-card').hidden = scriptType === 'bdd';
      } else if (act === 'add-link') {
        const ref = $('#l-ref').value.trim();
        if (!ref) { $('#l-ref').focus(); return; }
        if (!links.some((l) => l.ref.toLowerCase() === ref.toLowerCase())) links.push({ ref, title: $('#l-title').value.trim(), url: $('#l-url').value.trim(), href: $('#l-url').value.trim() });
        ['#l-ref', '#l-title', '#l-url'].forEach((s) => { $(s).value = ''; });
        $('#links').innerHTML = linksHtml();
        $('#l-ref').focus();
      } else if (act === 'del-link') {
        links.splice(Number(b.dataset.i), 1);
        $('#links').innerHTML = linksHtml();
      } else if (['add-col', 'del-col', 'add-row', 'del-row'].includes(act)) {
        syncParams();
        if (act === 'add-col') { params.columns.push(''); params.rows.forEach((r) => r.push('')); if (!params.rows.length) params.rows.push(['']); }
        if (act === 'del-col') { const j = Number(b.dataset.j); params.columns.splice(j, 1); params.rows.forEach((r) => r.splice(j, 1)); if (!params.columns.length) params.rows = []; }
        if (act === 'add-row') params.rows.push(params.columns.map(() => ''));
        if (act === 'del-row') params.rows.splice(Number(b.dataset.i), 1);
        $('#params').innerHTML = paramsHtml();
        if (act === 'add-col') $$('[data-col]', view).at(-1).focus();
        if (act === 'add-row') $$('[data-cell]', view).at(-params.columns.length)?.focus();
      } else if (act === 'paste-data') {
        openDialog(`<h2>Paste data from a spreadsheet</h2>
          <p class="muted">Copy cells from Excel, Sheets or a CSV file. The first line holds the column names. This replaces the current data sets.</p>
          <label>Data<textarea name="data" rows="8" required placeholder="email,password\nann@example.com,secret1\nbob@example.com,secret2"></textarea></label>
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Use this data</button></footer>`,
          async (fd) => {
            const lines = String(fd.get('data')).split(/\r?\n/).filter((l) => l.trim());
            const sep = lines.some((l) => l.includes('\t')) ? '\t' : ',';
            const cut = (l) => l.split(sep).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
            if (lines.length < 2) throw new Error('Paste a header line and at least one data row');
            syncParams();
            params = { columns: cut(lines[0]), rows: lines.slice(1).map(cut) };
            $('#params').innerHTML = paramsHtml();
          });
      } else if (['add', 'add-call', 'up', 'down', 'del'].includes(act)) {
        sync();
        if (act === 'add') steps.push({});
        if (act === 'add-call') steps.push({ call_case_id: 0 });
        if (act === 'del') { steps.splice(i, 1); if (!steps.length) steps.push({}); }
        if (act === 'up') [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
        if (act === 'down') [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
        $('#steps').innerHTML = stepRows();
        if (act === 'add') $('#steps .steprow:last-child textarea').focus();
        if (act === 'add-call') $('#steps .steprow:last-child select').focus();
      } else if (act === 'save') {
        sync();
        syncParams();
        if (steps.some((s) => s.call_case_id === 0)) throw new Error('Choose which test case each “call” step should run');
        const body = { script_type: scriptType, bdd_script: $('#f-bdd').value, ...(cfDefs.length ? { fields: readFields(view, cfDefs) } : {}), steps, params: params.columns.length ? params : null, links: links.map(({ ref, title, url }) => ({ ref, title, url })) };
        for (const f of ['title', 'folder', 'labels', 'automation_key', 'priority', 'status', 'objective', 'precondition']) body[f] = $(`#f-${f}`).value;
        if (!body.title.trim()) { $('#f-title').focus(); throw new Error('Title is required'); }
        if (isNew) await api('POST', `/api/projects/${STATE.pid}/cases`, body);
        else await api('PUT', `/api/cases/${id}`, body);
        toast('Test case saved');
        location.hash = '#/cases';
      } else if (act === 'compare') {
        await openVersionDiff(id, Number(b.dataset.v), c, allCases);
      } else if (act === 'restore') {
        const v = Number(b.dataset.v);
        if (!confirm(`Restore version ${v}?\n\nIts content becomes the current version (as a new version). Nothing is lost: the history keeps every version.`)) return;
        const r = await api('POST', `/api/cases/${id}/versions/${v}/restore`);
        toast(`Restored v${v} as v${r.version}`);
        router();
      } else if (act === 'run') {
        await runCase(id);
      } else if (act === 'clone') {
        const r = await api('POST', `/api/cases/${id}/clone`, {});
        toast(`Cloned as ${esc(r.key)}`);
        location.hash = `#/cases/${r.id}`;
      } else if (act === 'delete') {
        if (!confirm(`Delete ${c.key}? It moves to Trash, where you can restore it. Past executions and bugs are kept.`)) return;
        const r = await api('DELETE', `/api/cases/${id}`);
        location.hash = '#/cases';
        deletedToast(c.key, r.trashId);
      }
    } catch (err) { fail(err); }
  };
}

const DIFF_FIELDS = { title: 'Title', objective: 'Objective', precondition: 'Preconditions', priority: 'Priority', status: 'Status', labels: 'Labels', params: 'Data sets' };
const stepText = (s, names = []) => (!s ? '' : s.call_case_id ? `Calls test case ${(names.find((x) => x.id === s.call_case_id) || {}).key || '#' + s.call_case_id}` : [s.action, s.test_data && `Data: ${s.test_data}`, s.expected && `Expect: ${s.expected}`].filter(Boolean).join('\n'));
const paramsOf = (x) => { try { const p = typeof x === 'string' ? (x ? JSON.parse(x) : null) : x; return p && p.columns && p.columns.length ? p : null; } catch { return null; } };
const paramsText = (p) => (p ? `${p.columns.join(', ')} · ${p.rows.length} row${p.rows.length === 1 ? '' : 's'}` : '');

// Compare an older version with the current saved one. Differences are named in words, not only styled.
async function openVersionDiff(caseId, version, current, names = []) {
  const old = (await api('GET', `/api/cases/${caseId}/versions/${version}`)).snapshot;
  const oldP = paramsOf(old.params), curP = paramsOf(current.params);
  const same = (f) => (f === 'params' ? JSON.stringify(oldP) === JSON.stringify(curP) : String(old[f] ?? '') === String(current[f] ?? ''));
  const fields = Object.keys(DIFF_FIELDS).filter((f) => !same(f));
  const n = Math.max(old.steps.length, current.steps.length);
  const steps = [];
  for (let i = 0; i < n; i++) {
    const o = old.steps[i], c = current.steps[i];
    const a = stepText(o, names), b = stepText(c, names);
    if (a === b) continue;
    steps.push({ no: i + 1, kind: !o ? 'Added since' : !c ? 'Removed since' : 'Changed', a, b });
  }
  const cell = (t) => (t ? `<p class="pre">${esc(t)}</p>` : '<p class="muted">—</p>');
  openDialog(`<h2>Version ${version} compared with the current version (v${current.version})</h2>
    ${!fields.length && !steps.length ? '<p>The content is identical.</p>' : `<div class="tscroll"><table class="diff"><thead><tr><th>What</th><th>Version ${version}</th><th>Current (v${current.version})</th></tr></thead><tbody>
      ${fields.map((f) => { const o = f === 'params' ? paramsText(oldP) : old[f], n = f === 'params' ? paramsText(curP) : current[f]; return `<tr><td><b>${DIFF_FIELDS[f]}</b> <span class="pill changed">Changed</span></td><td class="was">${cell(o === n ? `${o} (values differ)` : o)}</td><td>${cell(o === n ? `${n} (values differ)` : n)}</td></tr>`; }).join('')}
      ${steps.map((s) => `<tr><td><b>Step ${s.no}</b> <span class="pill ${s.kind.split(' ')[0].toLowerCase()}">${s.kind}</span></td><td class="was">${cell(s.a)}</td><td>${cell(s.b)}</td></tr>`).join('')}
    </tbody></table></div>`}
    <footer><button type="button" class="btn ghost" data-close>Close</button></footer>`, async () => {});
}

// ---------- cycles ----------
function casePicker(cases) {
  return cases.length ? `<div class="picker"><label class="all"><input type="checkbox" data-all checked> Select all</label>
    ${cases.map((c) => `<label><input type="checkbox" name="case" value="${c.id}" checked> <span class="key">${esc(c.key)}</span> ${esc(c.title)} <small>${esc(c.folder)}</small></label>`).join('')}</div>`
    : '<p class="empty">No test cases available.</p>';
}
const wirePicker = (form) => { form.onchange = (e) => { if (e.target.matches('[data-all]')) $$('[name=case]', form).forEach((x) => { x.checked = e.target.checked; }); }; };

// New cycle dialog, shared by the cycles page and a plan page (which fixes the plan).
async function openNewCycle({ planId = null } = {}) {
  const [all, plans] = await Promise.all([api('GET', `/api/projects/${STATE.pid}/cases`), planId ? [] : api('GET', `/api/projects/${STATE.pid}/plans`)]);
  const cases = all.filter((c) => c.status !== 'Deprecated');
  const cyDefs = await api('GET', `/api/projects/${STATE.pid}/fields?entity=cycle`);
  openDialog(`<h2>New test cycle</h2>
    <label>Name<input name="name" required maxlength="120" placeholder="e.g. Release 2.3 regression" autofocus></label>
    <div class="two"><label>Environment<input name="environment" placeholder="Staging · Chrome"></label><label>Build / version<input name="build" placeholder="2.3.0-rc1"></label></div>
    <div class="two"><label>Start date<input type="date" name="start_date"></label><label>Due date<input type="date" name="due_date"></label></div>
    ${planId ? '' : `<label>Test plan<select name="plan_id"><option value="">No plan</option>${plans.map((p) => `<option value="${p.id}">${esc(p.key)} ${esc(p.name)}</option>`).join('')}</select></label>`}
    ${cyDefs.length ? `<div class="form">${fieldInputs(cyDefs, {}, 'cy')}</div>` : ''}
    <h3>Test cases</h3>${casePicker(cases)}
    <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Create cycle</button></footer>`,
    async (fd) => {
      const r = await api('POST', `/api/projects/${STATE.pid}/cycles`, {
        name: fd.get('name'), environment: fd.get('environment'), build: fd.get('build'), start_date: fd.get('start_date'), due_date: fd.get('due_date'),
        plan_id: planId || (fd.get('plan_id') ? Number(fd.get('plan_id')) : null), caseIds: fd.getAll('case').map(Number), ...(cyDefs.length ? { fields: readFields(dlg, cyDefs) } : {}),
      });
      location.hash = `#/cycles/${r.id}`;
    }, wirePicker);
}

// ---------- test plans ----------
const planCounts = (p) => ({ pass: p.pass, fail: p.fail, blocked: p.blocked, rest: p.not_executed + p.in_progress });

async function viewPlans() {
  const plans = await api('GET', `/api/projects/${STATE.pid}/plans`);
  view.innerHTML = `
    <header class="head"><h1>Test plans</h1><button class="btn primary" data-act="new">${withIcon('plus', 'New plan')}</button></header>
    <p class="meta">A test plan groups cycles, for example everything you run for one release, and shows their combined progress.</p>
    <section class="card flush">${plans.length ? `<table><thead><tr><th>Plan</th><th class="num">Cycles</th><th class="w-bar">Progress</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Blocked</th><th class="num">Left</th></tr></thead><tbody>
      ${plans.map((p) => `<tr><td><a href="#/plans/${p.id}"><span class="key">${esc(p.key)}</span> ${esc(p.name)}</a></td><td class="num">${p.cycles}</td><td>${bar(p)}</td>
        <td class="num">${p.pass}</td><td class="num">${p.fail}</td><td class="num">${p.blocked}</td><td class="num">${p.not_executed + p.in_progress}</td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">No test plans yet. Create one, then add cycles to it.</p>'}</section>`;
  view.onclick = (e) => {
    if (!e.target.closest('[data-act=new]')) return;
    openDialog(`<h2>New test plan</h2>
      <label>Name<input name="name" required maxlength="200" placeholder="e.g. Release 2.3" autofocus></label>
      <label>Description<textarea name="description" rows="3" maxlength="5000"></textarea></label>
      <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Create plan</button></footer>`,
      async (fd) => { const r = await api('POST', `/api/projects/${STATE.pid}/plans`, { name: fd.get('name'), description: fd.get('description') }); location.hash = `#/plans/${r.id}`; });
  };
}

async function viewPlan(id) {
  const p = await api('GET', `/api/plans/${id}`);
  const d = p.pass + p.fail + p.blocked;
  view.innerHTML = `
    <header class="head"><h1><span class="key">${esc(p.key)}</span> ${esc(p.name)}</h1>
      <span><button class="btn danger" data-act="delete">${withIcon('trash', 'Delete')}</button>
      <button class="btn ghost" data-act="edit">${withIcon('pencil', 'Edit')}</button>
      <button class="btn ghost" data-act="export">${withIcon('download', 'Export')}</button>
      <button class="btn ghost" data-act="add"${p.available.length ? '' : ' disabled'}>${withIcon('plus', 'Add existing cycles')}</button>
      <button class="btn primary" data-act="new-cycle">${withIcon('plus', 'New cycle in this plan')}</button></span></header>
    ${p.description ? `<p class="pre meta">${esc(p.description)}</p>` : ''}
    <section class="card"><h2>Progress across ${p.cycles} cycle${p.cycles === 1 ? '' : 's'}</h2>
      ${p.total ? `<div class="bar thick" role="img" aria-label="${p.pass} passed, ${p.fail} failed, ${p.blocked} blocked of ${p.total}">${[['pass', p.pass], ['fail', p.fail], ['blocked', p.blocked], ['rest', p.not_executed + p.in_progress]].filter(([, n]) => n).map(([k, n]) => `<i class="${k}" style="width:${(n / p.total) * 100}%" title="${k}: ${n}"></i>`).join('')}</div>${legend(planCounts(p))}
      <p class="muted">${d ? `${Math.round((p.pass / d) * 100)}% of the ${d} decided results passed` : 'Nothing has been run yet'} · ${p.total} test executions in total</p>` : '<p class="muted">No test executions yet. Add cycles with test cases to this plan.</p>'}
    </section>
    <section class="card flush">${p.cycleList.length ? `<table><thead><tr><th>Cycle</th><th>Environment</th><th>Build</th><th class="w-bar">Progress</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Blocked</th><th class="num">Left</th><th></th></tr></thead><tbody>
      ${p.cycleList.map((c) => `<tr><td><a href="#/cycles/${c.id}"><span class="key">${esc(c.key)}</span> ${esc(c.name)}</a></td><td>${esc(c.environment)}</td><td>${esc(c.build)}</td><td>${bar(c)}</td>
        <td class="num">${c.pass}</td><td class="num">${c.fail}</td><td class="num">${c.blocked}</td><td class="num">${c.not_executed + c.in_progress}</td>
        <td class="num"><button type="button" class="icon small" data-act="unplan" data-id="${c.id}" title="Remove from this plan" aria-label="Remove ${esc(c.key)} from this plan">${icon('x')}</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">This plan has no cycles yet.</p>'}</section>`;
  view.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    try {
      if (b.dataset.act === 'new-cycle') await openNewCycle({ planId: p.id });
      else if (b.dataset.act === 'unplan') { await api('PUT', `/api/cycles/${b.dataset.id}`, { plan_id: null }); toast('Removed from the plan'); router(); }
      else if (b.dataset.act === 'export') openExport({ title: `Export ${p.key}`, base: `/api/plans/${p.id}/export`, note: 'One row per cycle with its counts and pass rate.' });
      else if (b.dataset.act === 'delete') {
        if (!confirm(`Delete plan ${p.key}?\n\nIts ${p.cycles} cycle${p.cycles === 1 ? '' : 's'} and all results are kept, they just stop being grouped.`)) return;
        await api('DELETE', `/api/plans/${p.id}`);
        location.hash = '#/plans';
      } else if (b.dataset.act === 'edit') {
        openDialog(`<h2>Edit ${esc(p.key)}</h2>
          <label>Name<input name="name" required maxlength="200" value="${esc(p.name)}"></label>
          <label>Description<textarea name="description" rows="3" maxlength="5000">${esc(p.description)}</textarea></label>
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></footer>`,
          async (fd) => { await api('PUT', `/api/plans/${p.id}`, { name: fd.get('name'), description: fd.get('description') }); toast('Plan saved'); router(); });
      } else if (b.dataset.act === 'add') {
        openDialog(`<h2>Add cycles to ${esc(p.key)}</h2>
          <div class="picker">${p.available.map((c) => `<label><input type="checkbox" name="cycle" value="${c.id}"> <span class="key">${esc(c.key)}</span> ${esc(c.name)}</label>`).join('')}</div>
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Add to plan</button></footer>`,
          async (fd) => { const ids = fd.getAll('cycle').map(Number); if (!ids.length) throw new Error('Tick at least one cycle'); await api('POST', `/api/plans/${p.id}/cycles`, { cycleIds: ids }); toast('Cycles added'); router(); });
      }
    } catch (err) { fail(err); }
  };
}

const dueCell = (c) => (!c.due_date ? '<span class="muted">—</span>' : `${esc(c.due_date)}${c.overdue ? ` <span class="pill fail">Overdue</span>` : ''}`);

async function viewCycles() {
  const all = await api('GET', `/api/projects/${STATE.pid}/cycles`);
  let cyFilter = 'all';
  try { cyFilter = sessionStorage.getItem('cyfilter') || 'all'; } catch { /* ignore */ }
  const left = (c) => c.not_executed + c.in_progress;
  const cycles = all.filter((c) => cyFilter === 'all' || (cyFilter === 'overdue' ? c.overdue : cyFilter === 'finished' ? !c.adhoc && c.total > 0 && left(c) === 0 : !c.adhoc && (left(c) > 0 || c.total === 0)));
  view.innerHTML = `
    <header class="head"><h1>Test cycles</h1><button class="btn primary" data-act="new">${withIcon('plus', 'New cycle')}</button></header>
    <div class="filters"><select id="cyfilter" aria-label="Show">${[['all', 'All cycles'], ['active', 'Still to run'], ['overdue', 'Overdue'], ['finished', 'Finished']].map(([v, l]) => `<option value="${v}"${cyFilter === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <span class="viewsbar" id="viewsbar"></span></div>
    <section class="card flush">${cycles.length ? `<table><thead><tr><th>Cycle</th><th>Plan</th><th>Environment</th><th>Build</th><th>Due</th><th class="w-bar">Progress</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Blocked</th><th class="num">Left</th></tr></thead><tbody>
      ${cycles.map((c) => `<tr><td><a href="#/cycles/${c.id}"><span class="key">${esc(c.key)}</span> ${esc(c.name)}</a></td><td>${c.plan_id ? `<a href="#/plans/${c.plan_id}">${esc(c.plan_name)}</a>` : '<span class="muted">—</span>'}</td><td>${c.adhoc ? '<span class="muted">Standalone</span>' : esc(c.environment)}</td><td>${esc(c.build)}</td><td>${dueCell(c)}</td>
        <td>${bar(c)}</td><td class="num">${c.pass}</td><td class="num">${c.fail}</td><td class="num">${c.blocked}</td><td class="num">${c.not_executed + c.in_progress}</td></tr>`).join('')}
      </tbody></table>` : `<p class="empty">${all.length ? 'No cycles match this filter.' : 'No cycles yet. A cycle is one run of a set of test cases against a build.'}</p>`}</section>`;
  mountViews($('#viewsbar'), 'cycles', () => ({ cyfilter: cyFilter }),
    (st) => { try { sessionStorage.setItem('cyfilter', st.cyfilter || 'all'); } catch { /* ignore */ } router(); });
  view.onchange = (e) => { if (e.target.id === 'cyfilter') { try { sessionStorage.setItem('cyfilter', e.target.value); } catch { /* ignore */ } router(); } };
  view.onclick = (e) => { if (e.target.closest('[data-act=new]')) openNewCycle().catch(fail); };
}

async function viewCycle(id) {
  const c = await api('GET', `/api/cycles/${id}`);
  const counts = { total: c.executions.length, pass: 0, fail: 0, blocked: 0, in_progress: 0 };
  c.executions.forEach((e) => { const k = cls(e.status).replace('-', '_'); if (k in counts) counts[k]++; });
  const next = c.executions.find((e) => e.status === 'Not Executed' || e.status === 'In Progress');
  view.innerHTML = `
    <header class="head"><h1><span class="key">${esc(c.key)}</span> ${esc(c.name)}</h1>
      <span><button class="btn danger" data-act="delete">${withIcon('trash', 'Delete')}</button>
      ${c.adhoc ? '' : `<button class="btn ghost" data-act="edit">${withIcon('pencil', 'Edit')}</button> <button class="btn ghost" data-act="clone">${withIcon('copy', 'Clone')}</button>`}
      <button class="btn ghost" data-act="export">${withIcon('download', 'Export results')}</button>
      ${c.adhoc ? '' : `<button class="btn ghost" data-act="add">${withIcon('plus', 'Add test cases')}</button> <button class="btn ghost" data-act="assign">${withIcon('users', 'Assign runs')}</button>`}
      ${next ? `<a class="btn primary" href="#/run/${next.id}">${icon('play')}<span>${counts.pass + counts.fail + counts.blocked + counts.in_progress ? 'Continue' : 'Start'} testing</span></a>` : ''}</span></header>
    <p class="meta">${[c.adhoc && c.description, c.environment, c.build && `Build ${c.build}`, `Created ${fmtDate(c.created_at)}`].filter(Boolean).map(esc).join(' · ')}${c.plan_id ? ` · Plan <a href="#/plans/${c.plan_id}">${esc(c.plan_key)} ${esc(c.plan_name)}</a>` : ''}${c.due_date ? ` · Due ${esc(c.due_date)}` : ''}${c.overdue ? ' · <span class="pill fail">Overdue</span>' : ''}${c.created_by_name ? ` · by ${esc(c.created_by_name)}` : ''}</p>
    <section class="card">${bar(counts)}<p class="legend">${counts.pass} passed · ${counts.fail} failed · ${counts.blocked} blocked · ${counts.total - counts.pass - counts.fail - counts.blocked} remaining</p></section>
    <section class="card flush">${c.executions.length ? `<table><thead><tr><th>Test case</th><th>Status</th><th class="num">Steps done</th><th class="num">Bugs</th>${c.executions.some((e) => e.duration_ms > 0) ? '<th class="num">Took</th>' : ''}<th>Assignee</th><th>Last run</th><th></th></tr></thead><tbody>
      ${c.executions.map((e) => `<tr><td><a href="#/run/${e.id}"><span class="key">${esc(e.case_key)}</span> ${esc(e.case_title)}</a>${e.iteration ? ` <span class="muted">· data set ${e.iteration}: ${esc(e.iteration_label)}</span>` : ''}</td><td>${pill(e.status)}</td>
        <td class="num">${e.steps_done}/${e.step_count}</td><td class="num">${e.bug_count || ''}</td>${c.executions.some((x) => x.duration_ms > 0) ? `<td class="num muted">${fmtMs(e.duration_ms)}</td>` : ''}<td>${userSelect(`data-assign="${e.id}" aria-label="Assignee for ${esc(e.case_key)}"`, e.assignee_id, e.assignee_name)}</td>
        <td class="muted">${e.executed_by_name ? esc(e.executed_by_name) + ' · ' : ''}${fmtDate(e.executed_at)}</td>
        <td class="num"><button type="button" class="icon small danger" data-rm-run="${e.id}" data-key="${esc(e.case_key)}" title="Remove this run from the cycle" aria-label="Remove ${esc(e.case_key)} from the cycle">${icon('trash')}</button> <a class="btn small ghost" href="#/run/${e.id}">${icon('play')}<span>${e.status === 'Not Executed' ? 'Run' : 'Open'}</span></a></td></tr>`).join('')}
      </tbody></table>` : `<p class="empty">${c.adhoc ? 'No standalone runs yet. Press “Run” on a test case.' : 'This cycle has no test cases yet.'}</p>`}</section>`;
  view.onchange = async (e) => {
    const sel = e.target.closest('[data-assign]');
    if (!sel) return;
    try { await api('PUT', `/api/executions/${sel.dataset.assign}`, { assignee_id: sel.value ? Number(sel.value) : null }); toast('Assignee saved'); }
    catch (err) { fail(err); router(); }
  };
  view.onclick = async (e) => {
    const rm = e.target.closest('[data-rm-run]');
    if (rm) {
      try {
        if (!confirm(`Remove ${rm.dataset.key} from ${c.key}? Its result and screenshots go to Trash, where you can restore them.`)) return;
        const r = await api('DELETE', `/api/executions/${rm.dataset.rmRun}`);
        await router();
        deletedToast(`${rm.dataset.key} run`, r.trashId);
      } catch (err) { fail(err); }
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'delete') {
        if (!confirm(`Delete cycle ${c.key} with all its results and screenshots? It moves to Trash, where you can restore it. Bugs already filed are kept.`)) return;
        const r = await api('DELETE', `/api/cycles/${id}`);
        location.hash = '#/cycles';
        deletedToast(c.key, r.trashId);
      } else if (act === 'edit') {
        const plans = await api('GET', `/api/projects/${STATE.pid}/plans`);
        const cyDefs = await api('GET', `/api/projects/${STATE.pid}/fields?entity=cycle`);
        openDialog(`<h2>Edit ${esc(c.key)}</h2>
          <label>Name<input name="name" required maxlength="200" value="${esc(c.name)}"></label>
          <div class="two"><label>Environment<input name="environment" value="${esc(c.environment)}"></label><label>Build / version<input name="build" value="${esc(c.build)}"></label></div>
          <div class="two"><label>Start date<input type="date" name="start_date" value="${esc(c.start_date)}"></label><label>Due date<input type="date" name="due_date" value="${esc(c.due_date)}"></label></div>
          <label>Test plan<select name="plan_id"><option value="">No plan</option>${plans.map((p) => `<option value="${p.id}"${p.id === c.plan_id ? ' selected' : ''}>${esc(p.key)} ${esc(p.name)}</option>`).join('')}</select></label>
          ${cyDefs.length ? `<div class="form">${fieldInputs(cyDefs, c.fields, 'cy')}</div>` : ''}
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></footer>`,
          async (fd) => { await api('PUT', `/api/cycles/${id}`, { name: fd.get('name'), environment: fd.get('environment'), build: fd.get('build'), start_date: fd.get('start_date'), due_date: fd.get('due_date'), plan_id: fd.get('plan_id') ? Number(fd.get('plan_id')) : null, ...(cyDefs.length ? { fields: readFields(dlg, cyDefs) } : {}) }); toast('Cycle saved'); router(); });
      } else if (act === 'assign') {
        const unassigned = c.executions.filter((x) => !x.assignee_id).length, unfinished = c.executions.filter((x) => x.status === 'Not Executed' || x.status === 'In Progress').length;
        openDialog(`<h2>Assign runs in ${esc(c.key)}</h2>
          <fieldset><legend>What to do</legend>
            <label class="radio"><input type="radio" name="mode" value="distribute" checked> <span>Share evenly between the people ticked below</span></label>
            <label class="radio"><input type="radio" name="mode" value="one"> <span>Give them all to the first person ticked</span></label>
            <label class="radio"><input type="radio" name="mode" value="clear"> <span>Remove assignees</span></label></fieldset>
          <fieldset><legend>Which runs</legend>
            <label class="radio"><input type="radio" name="only" value="unassigned" checked> <span>Only runs nobody has yet (${unassigned})</span></label>
            <label class="radio"><input type="radio" name="only" value="unfinished"> <span>All runs still to do (${unfinished}), even if assigned</span></label>
            <label class="radio"><input type="radio" name="only" value="all"> <span>Every run (${c.executions.length})</span></label></fieldset>
          <fieldset><legend>People</legend>${STATE.users.map((u) => `<label class="check"><input type="checkbox" name="who" value="${u.id}"> ${esc(u.display_name)}</label>`).join('')}</fieldset>
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Assign</button></footer>`,
          async (fd) => {
            const who = fd.getAll('who').map(Number), mode = fd.get('mode');
            if (mode !== 'clear' && !who.length) throw new Error('Tick at least one person');
            const r = await api('POST', `/api/cycles/${id}/assign`, { mode, only: fd.get('only'), userIds: who, userId: who[0] });
            toast(mode === 'clear' ? `Cleared ${r.count} assignment${r.count === 1 ? '' : 's'}` : `Assigned ${r.count} run${r.count === 1 ? '' : 's'}`); router();
          });
      } else if (act === 'export') {
        openExport({ title: `Export results of ${c.key}`, base: `/api/cycles/${id}/export`, note: 'One row per step with its status, actual result and linked bugs.' });
      } else if (act === 'clone') {
        const count = (...st) => c.executions.filter((x) => st.includes(x.status)).length;
        const notPassed = c.executions.length - count('Pass'), failed = count('Fail', 'Blocked');
        openDialog(`<h2>Clone ${esc(c.key)}</h2>
          <p class="muted">Creates a new cycle with clean, unexecuted results. Test cases use their latest saved steps.</p>
          <label>Name<input name="name" required maxlength="200" value="${esc(c.name)} (copy)"></label>
          <div class="two"><label>Environment<input name="environment" value="${esc(c.environment)}"></label><label>Build / version<input name="build" value="${esc(c.build)}"></label></div>
          <fieldset><legend>Include</legend>
            <label class="radio"><input type="radio" name="include" value="all" checked> <span>All test cases (${c.executions.length})</span></label>
            <label class="radio"><input type="radio" name="include" value="unpassed"${notPassed ? '' : ' disabled'}> <span>Everything that has not passed (${notPassed})</span></label>
            <label class="radio"><input type="radio" name="include" value="failed"${failed ? '' : ' disabled'}> <span>Only failed and blocked (${failed})</span></label>
          </fieldset>
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${withIcon('copy', 'Clone cycle')}</button></footer>`,
          async (fd) => {
            const r = await api('POST', `/api/cycles/${id}/clone`, { name: fd.get('name'), environment: fd.get('environment'), build: fd.get('build'), include: fd.get('include') });
            toast(`Created ${esc(r.key)} with ${r.added} test case${r.added === 1 ? '' : 's'}`);
            location.hash = `#/cycles/${r.id}`;
          });
      } else if (act === 'add') {
        const have = new Set(c.executions.map((x) => x.case_id));
        const cases = (await api('GET', `/api/projects/${STATE.pid}/cases`)).filter((x) => !have.has(x.id) && x.status !== 'Deprecated');
        openDialog(`<h2>Add test cases</h2>${casePicker(cases)}
          <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary"${cases.length ? '' : ' disabled'}>Add</button></footer>`,
          async (fd) => { await api('POST', `/api/cycles/${id}/cases`, { caseIds: fd.getAll('case').map(Number) }); router(); }, wirePicker);
      }
    } catch (err) { fail(err); }
  };
}

// ---------- test player ----------
async function viewRun(id) {
  let ex = await api('GET', `/api/executions/${id}`);
  let active = (ex.steps.find((s) => s.status === 'Not Executed') || ex.steps.find((s) => s.status === 'Fail') || ex.steps[0])?.id;
  const stepById = (sid) => ex.steps.find((s) => s.id === Number(sid));
  const thumbs = (list, removable) => list.map((a) => attHtml(a, { removable, annotate: removable })).join('');

  const stepCard = (s) => `<article class="step ${cls(s.status)}${s.id === active ? ' active' : ''}" data-step="${s.id}">
      <header><span class="n">${s.position}</span>${pill(s.status)}${s.origin ? `<span class="chip ext" title="This step comes from test case ${esc(s.origin)}">from ${esc(s.origin)}</span>` : ''}
        ${s.bugs.map((b) => `<a class="chip" href="#/bugs/${b.id}" title="${esc(b.title)}">${esc(b.key)} · ${esc(b.status)}</a>`).join('')}</header>
      <div class="cols">
        <div><h4>Action</h4><p class="pre">${esc(s.action)}</p>${s.test_data ? `<h4>Test data</h4><p class="pre data">${esc(s.test_data)}</p>` : ''}</div>
        <div><h4>Expected result</h4><p class="pre">${esc(s.expected)}</p></div>
      </div>
      <label class="actual">Actual result<textarea data-actual rows="2" placeholder="What actually happened (needed for a good bug report)">${esc(s.actual)}</textarea></label>
      <div class="shots">${thumbs(s.attachments, true)}
        <label class="btn small ghost">${withIcon('image', 'Add screenshot or file')}<input type="file" accept="${ACCEPT}" multiple hidden data-upload></label>
        <span class="muted">or paste (Ctrl+V) / drop an image or file</span></div>
      <footer>
        <button type="button" class="btn st pass${s.status === 'Pass' ? ' on' : ''}" data-act="status" data-v="Pass">${withIcon('check', 'Pass')}</button>
        <button type="button" class="btn st fail${s.status === 'Fail' ? ' on' : ''}" data-act="status" data-v="Fail">${withIcon('x', 'Fail')}</button>
        <button type="button" class="btn st blocked${s.status === 'Blocked' ? ' on' : ''}" data-act="status" data-v="Blocked">${withIcon('ban', 'Blocked')}</button>
        ${s.status !== 'Not Executed' ? `<button type="button" class="btn small ghost" data-act="status" data-v="Not Executed">${withIcon('rotate', 'Reset')}</button>` : ''}
        ${s.status === 'Fail' ? `<button type="button" class="btn bug" data-act="bug">${withIcon('bug', s.bugs.length ? 'Create another bug' : 'Create bug')}</button>` : ''}
      </footer></article>`;

  const render = () => {
    view.innerHTML = `
      <header class="head"><h1><span class="key">${esc(ex.case_key)}</span> ${esc(ex.case_title)}</h1>
        <span>${ex.prev ? `<a class="btn ghost" href="#/run/${ex.prev}">${icon('arrow-left')}<span>Previous</span></a>` : ''}
        ${ex.adhoc ? `<span class="muted">Standalone run${ex.count > 1 ? ` · ${ex.index} of ${ex.count}` : ''}</span>${ex.case_id ? ` <button class="btn ghost" data-act="rerun">${withIcon('rotate', 'Run again')}</button>` : ''}` : `<span class="muted">${ex.index} of ${ex.count}</span>`}
        ${ex.next ? `<a class="btn ghost" href="#/run/${ex.next}"><span>Next</span>${icon('arrow-right')}</a>` : ''}</span></header>
      <p class="meta"><a href="#/cycles/${ex.cycle_id}">${esc(ex.cycle_key)} ${esc(ex.cycle_name)}</a>${[ex.environment, ex.build && `Build ${ex.build}`].filter(Boolean).map((x) => ' · ' + esc(x)).join('')}
        · ${pill(ex.status)}${ex.assignee_name ? ` · Assigned to ${esc(ex.assignee_name)}` : ''}${ex.executed_by_name ? ` · Last run by ${esc(ex.executed_by_name)}` : ''}${ex.iteration ? ` · Data set ${ex.iteration}: ${esc(ex.iteration_label)}` : ''}${ex.case_version ? ` · Test case v${ex.case_version}` : ''}${ex.case_id && ex.current_version > ex.case_version ? ` · <a href="#/cases/${ex.case_id}">the test case has changed since this run (now v${ex.current_version})</a>` : ''}</p>
      ${ex.precondition ? `<section class="card pre-box"><h4>Preconditions</h4><p class="pre">${esc(ex.precondition)}</p></section>` : ''}
      ${ex.steps.length ? ex.steps.map(stepCard).join('') : `<section class="card"><p class="empty">This test case has no steps. Set the result directly:</p>
        <p>${['Pass', 'Fail', 'Blocked'].map((v) => `<button class="btn st ${cls(v)}${ex.status === v ? ' on' : ''}" data-act="exec-status" data-v="${v}">${withIcon({ Pass: 'check', Fail: 'x', Blocked: 'ban' }[v], v)}</button>`).join(' ')}</p></section>`}
      <section class="card"><label>Run notes<textarea id="comment" rows="2" placeholder="Optional notes for this execution">${esc(ex.comment)}</textarea></label></section>
      <section class="card" id="discuss"></section>
      <p class="muted keys">Shortcuts on the highlighted step: <kbd>P</kbd> pass · <kbd>F</kbd> fail · <kbd>B</kbd> blocked · <kbd>J</kbd>/<kbd>K</kbd> next / previous step</p>`;
    mountDiscussion($('#discuss'), 'execution', ex.id, ex);
  };

  // Persist any typed-but-unsaved actual results before re-rendering.
  const flush = async () => {
    for (const card of $$('.step', view)) {
      const s = stepById(card.dataset.step);
      const v = $('[data-actual]', card).value;
      if (s && v !== s.actual) { await api('PUT', `/api/step-results/${s.id}`, { actual: v }); s.actual = v; }
    }
  };
  const reload = async () => { await flush(); ex = await api('GET', `/api/executions/${id}`); render(); };
  const setActive = (sid, scroll) => {
    active = Number(sid);
    $$('.step', view).forEach((c) => c.classList.toggle('active', Number(c.dataset.step) === active));
    if (scroll) $(`.step[data-step="${active}"]`, view)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const setStatus = async (sid, status) => {
    const card = $(`.step[data-step="${sid}"]`, view);
    await api('PUT', `/api/step-results/${sid}`, { status, actual: $('[data-actual]', card).value });
    stepById(sid).actual = $('[data-actual]', card).value;
    if (status === 'Pass') {
      const i = ex.steps.findIndex((s) => s.id === Number(sid));
      if (ex.steps[i + 1]) active = ex.steps[i + 1].id;
    } else active = Number(sid);
    await reload();
    if (status === 'Pass') setActive(active, true);
  };
  const upload = async (sid, files) => {
    if (!files.length || !sid) return;
    await uploadImages(`/api/step-results/${sid}/attachments`, files);
    await reload();
    toast(`${files.length} file${files.length > 1 ? 's' : ''} attached to step ${stepById(sid).position}`);
  };

  // --- one-click bug from a failed step ---
  const reproText = (s) => {
    const lines = ex.steps.filter((x) => x.position <= s.position)
      .map((x, i) => `${i + 1}. ${x.origin ? `[${x.origin}] ` : ''}${x.action.trim().replace(/\n+/g, ' ')}${x.test_data ? ` (data: ${x.test_data.trim().replace(/\n+/g, ' ')})` : ''}`);
    return (ex.iteration_label ? `Data set: ${ex.iteration_label}\n` : '') + (ex.precondition ? `Preconditions: ${ex.precondition.trim()}\n\n` : '') + lines.join('\n');
  };
  const openBugDialog = async (sid) => {
    await reload();
    const s = stepById(sid);
    const skipped = new Set();
    const shotsHtml = () => {
      const cur = stepById(sid);
      return cur.attachments.length ? cur.attachments.map((a) => attHtml(a, { pick: skipped })).join('') : '<span class="muted">No screenshots or files on this step yet.</span>';
    };
    const env = [ex.environment, ex.build && `Build ${ex.build}`].filter(Boolean).join(' · ');
    const title = `${firstLine(s.actual) || `Step ${s.position} failed: ${firstLine(s.action)}`}`.slice(0, 140);
    openDialog(`
      <h2>Create bug from failed step</h2>
      <p class="meta">${esc(ex.case_key)} · step ${s.position} · ${esc(ex.cycle_key)}</p>
      <label>Title<input name="title" required maxlength="300" value="${esc(title)}"></label>
      <div class="three">
        <label>Severity<select name="severity">${options(['Critical', 'Major', 'Minor', 'Trivial'], 'Major')}</select></label>
        <label>Priority<select name="priority">${options(['High', 'Medium', 'Low'], 'Medium')}</select></label>
        <label>Environment<input name="environment" value="${esc(env)}"></label>
      </div>
      <div class="two">
        <label>Expected result<textarea name="expected" rows="4">${esc(s.expected)}</textarea></label>
        <label>Actual result<textarea name="actual" rows="4" placeholder="Describe what happened instead">${esc(s.actual)}</textarea></label>
      </div>
      <label>Steps to reproduce
        <small>Pre-filled from the test steps up to the failure. Edit freely so a developer can recreate the issue.</small>
        <textarea name="steps_to_reproduce" rows="7">${esc(reproText(s))}</textarea></label>
      <p class="rowbtns"><button type="button" class="btn small ghost" data-repro="fill">Reset from test steps</button> <button type="button" class="btn small ghost" data-repro="clear">Clear</button></p>
      <h3>Screenshots</h3>
      <div class="shots" id="dlg-shots">${shotsHtml()}</div>
      <p class="rowbtns"><label class="btn small ghost">${withIcon('image', 'Add screenshot or file')}<input type="file" accept="${ACCEPT}" multiple hidden data-dlg-upload></label>
        <span class="muted">or paste (Ctrl+V). Ticked screenshots are copied to the bug.</span></p>
      <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn bug">${withIcon('bug', 'Create bug')}</button></footer>`,
      async (fd) => {
        const r = await api('POST', `/api/step-results/${sid}/bug`, {
          title: fd.get('title'), severity: fd.get('severity'), priority: fd.get('priority'), environment: fd.get('environment'),
          expected: fd.get('expected'), actual: fd.get('actual'), steps_to_reproduce: fd.get('steps_to_reproduce'),
          attachmentIds: fd.getAll('att').map(Number),
        });
        pasteHandler = (files) => upload(active, files).catch(fail);
        await reload();
        toast(`Bug <a href="#/bugs/${r.id}">${esc(r.key)}</a> created`);
      },
      (form) => {
        const addShots = async (files) => {
          if (!files.length) return;
          try {
            $$('[name=att]', form).forEach((x) => { if (!x.checked) skipped.add(Number(x.value)); else skipped.delete(Number(x.value)); });
            await uploadImages(`/api/step-results/${sid}/attachments`, files);
            ex = await api('GET', `/api/executions/${id}`);
            $('#dlg-shots').innerHTML = shotsHtml();
          } catch (err) { fail(err); }
        };
        pasteHandler = addShots;
        form.addEventListener('change', (e) => { if (e.target.matches('[data-dlg-upload]')) { addShots(filesFrom(e.target.files)); e.target.value = ''; } });
        form.addEventListener('click', (e) => {
          const r = e.target.closest('[data-repro]');
          if (r) form.elements.steps_to_reproduce.value = r.dataset.repro === 'fill' ? reproText(stepById(sid)) : '';
        });
        dlg.addEventListener('close', () => { pasteHandler = (files) => upload(active, files).catch(fail); render(); }, { once: true });
      });
  };

  render();
  pasteHandler = (files) => upload(active, files).catch(fail);
  keyHandler = (e) => {
    const k = e.key.toLowerCase();
    const i = ex.steps.findIndex((s) => s.id === active);
    if (i < 0) return;
    const map = { p: 'Pass', f: 'Fail', b: 'Blocked' };
    if (map[k]) { e.preventDefault(); setStatus(active, map[k]).catch(fail); }
    else if ((k === 'j' || k === 'arrowdown') && ex.steps[i + 1]) { e.preventDefault(); setActive(ex.steps[i + 1].id, true); }
    else if ((k === 'k' || k === 'arrowup') && ex.steps[i - 1]) { e.preventDefault(); setActive(ex.steps[i - 1].id, true); }
  };
  view.onclick = async (e) => {
    const card = e.target.closest('.step');
    if (card) setActive(card.dataset.step);
    const b = e.target.closest('[data-act]');
    if (!b) return;
    try {
      if (b.dataset.act === 'status') await setStatus(card.dataset.step, b.dataset.v);
      else if (b.dataset.act === 'bug') await openBugDialog(Number(card.dataset.step));
      else if (b.dataset.act === 'rm-shot') { await api('DELETE', `/api/attachments/${b.dataset.id}`); await reload(); }
      else if (b.dataset.act === 'annotate') await openAnnotator(Number(b.dataset.id), reload);
      else if (b.dataset.act === 'rerun') { await flush(); await runCase(ex.case_id); }
      else if (b.dataset.act === 'exec-status') { await api('PUT', `/api/executions/${id}`, { status: b.dataset.v }); await reload(); }
    } catch (err) { fail(err); }
  };
  view.onchange = async (e) => {
    try {
      if (e.target.matches('[data-upload]')) {
        const sid = Number(e.target.closest('.step').dataset.step);
        await upload(sid, filesFrom(e.target.files));
      } else if (e.target.matches('[data-actual]')) {
        const s = stepById(e.target.closest('.step').dataset.step);
        await api('PUT', `/api/step-results/${s.id}`, { actual: e.target.value });
        s.actual = e.target.value;
      } else if (e.target.id === 'comment') {
        await api('PUT', `/api/executions/${id}`, { comment: e.target.value });
        ex.comment = e.target.value;
      }
    } catch (err) { fail(err); }
  };
  view.ondragover = (e) => { if (e.target.closest('.step')) e.preventDefault(); };
  view.ondrop = (e) => {
    const card = e.target.closest('.step');
    const files = filesFrom(e.dataTransfer && e.dataTransfer.files);
    if (!card || !files.length) return;
    e.preventDefault();
    upload(Number(card.dataset.step), files).catch(fail);
  };
}

// ---------- bugs ----------
const PENDING_VIEW = { bugs: null }; // a saved view chosen on the bugs list, read once when the list is drawn
async function viewBugs() {
  const bugs = await api('GET', `/api/projects/${STATE.pid}/bugs`);
  let status = 'active', who = '';
  if (PENDING_VIEW.bugs) { status = PENDING_VIEW.bugs.status || 'active'; who = PENDING_VIEW.bugs.who || ''; PENDING_VIEW.bugs = null; }
  const sel = new Set();
  const visibleBugs = () => bugs.filter((b) => (status === 'all' || (status === 'active' ? ['Open', 'In Progress'].includes(b.status) : b.status === status))
      && (!who || (who === 'me' ? b.assignee_id === STATE.user.id : !b.assignee_id)));
  const rows = () => {
    const list = visibleBugs();
    return list.length ? list.map((b) => `<tr><td class="cb"><input type="checkbox" data-sel="${b.id}"${sel.has(b.id) ? ' checked' : ''} aria-label="Select ${esc(b.key)}"></td><td><a href="#/bugs/${b.id}"><span class="key">${esc(b.key)}</span> ${esc(b.title)}</a></td>
      <td>${pill(b.severity)}</td><td>${pill(b.priority)}</td><td>${pill(b.status)}</td><td>${esc(b.assignee_name || '—')}</td>
      <td class="muted">${b.case_key ? `${esc(b.case_key)} step ${b.step_no}` : 'Manual'}</td><td class="num">${b.shots || ''}</td><td class="muted">${fmtDate(b.created_at)}</td></tr>`).join('')
      : '<tr><td colspan="9" class="empty">No bugs here.</td></tr>';
  };
  view.innerHTML = `
    <header class="head"><h1>Bugs</h1><button class="btn primary" data-act="new">${withIcon('plus', 'New bug')}</button></header>
    <div class="filters"><select id="bstatus" aria-label="Status filter">
      <option value="active">Open &amp; in progress</option><option value="all">All</option><option>Open</option><option>In Progress</option><option>Resolved</option><option>Closed</option></select>
      <select id="bwho" aria-label="Assignee filter"><option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option></select>
      <span class="viewsbar" id="viewsbar"></span></div>
    <div class="bulk" id="bbulk" hidden></div>
    <section class="card flush"><table><thead><tr><th class="cb"><input type="checkbox" id="bsel-all" aria-label="Select all shown"></th><th>Bug</th><th>Severity</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Found by</th><th class="num">Screenshots</th><th>Created</th></tr></thead>
    <tbody id="rows">${rows()}</tbody></table></section>`;
  $('#bstatus').value = status; $('#bwho').value = who;
  mountViews($('#viewsbar'), 'bugs', () => ({ status, who }), (st) => { PENDING_VIEW.bugs = st; router(); });
  const paintBulk = () => {
    const bar = $('#bbulk');
    bar.hidden = !sel.size;
    bar.innerHTML = sel.size ? `<strong>${sel.size} selected</strong> <button type="button" class="btn small ghost" data-act="bbulk-edit">${withIcon('pencil', 'Edit…')}</button>
      <button type="button" class="btn small ghost" data-act="bbulk-clear">${withIcon('x', 'Clear')}</button>` : '';
    const all = $('#bsel-all'), shown = visibleBugs(), picked = shown.filter((b) => sel.has(b.id)).length;
    all.checked = !!shown.length && picked === shown.length;
    all.indeterminate = picked > 0 && picked < shown.length;
  };
  const repaint = () => { $('#rows').innerHTML = rows(); paintBulk(); };
  view.onchange = (e) => {
    const t = e.target;
    if (t.id === 'bstatus') status = t.value;
    else if (t.id === 'bwho') who = t.value;
    else if (t.id === 'bsel-all') { for (const b of visibleBugs()) { if (t.checked) sel.add(b.id); else sel.delete(b.id); } }
    else if (t.matches('[data-sel]')) { const id = Number(t.dataset.sel); if (t.checked) sel.add(id); else sel.delete(id); }
    else return;
    repaint();
  };
  view.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'bbulk-clear') { sel.clear(); repaint(); return; }
    if (act === 'bbulk-edit') {
      openDialog(`<h2>Edit ${sel.size} bug${sel.size === 1 ? '' : 's'}</h2><p class="muted">Only what you choose changes. People assigned to a bug are notified as usual.</p>
        <div class="two"><label>Status<select name="status"><option value="">Leave as it is</option>${['Open', 'In Progress', 'Resolved', 'Closed'].map((o) => `<option>${o}</option>`).join('')}</select></label>
          <label>Assignee<select name="assignee_id"><option value="__keep__">Leave as it is</option><option value="">Unassigned</option>${STATE.users.map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join('')}</select></label></div>
        <div class="two"><label>Severity<select name="severity"><option value="">Leave as it is</option>${['Critical', 'Major', 'Minor', 'Trivial'].map((o) => `<option>${o}</option>`).join('')}</select></label>
          <label>Priority<select name="priority"><option value="">Leave as it is</option>${['High', 'Medium', 'Low'].map((o) => `<option>${o}</option>`).join('')}</select></label></div>
        <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Apply</button></footer>`,
        async (fd) => {
          const as = fd.get('assignee_id');
          const r = await api('POST', `/api/projects/${STATE.pid}/bugs/bulk`, { ids: [...sel], status: fd.get('status'), severity: fd.get('severity'), priority: fd.get('priority'), assignee_id: as === '__keep__' ? '__keep__' : as === '' ? null : Number(as) });
          toast(`Updated ${r.count} bug${r.count === 1 ? '' : 's'}`);
          router();
        });
      return;
    }
    if (!e.target.closest('[data-act=new]')) return;
    openDialog(`<h2>New bug</h2><label>Title<input name="title" required maxlength="300" autofocus></label>
      <footer><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">Create</button></footer>`,
      async (fd) => { const r = await api('POST', `/api/projects/${STATE.pid}/bugs`, { title: fd.get('title') }); location.hash = `#/bugs/${r.id}`; });
  };
}

function bugMarkdown(b) {
  const sec = (h, t) => (t && t.trim() ? `\n## ${h}\n${t.trim()}\n` : '');
  return `# ${b.key}: ${b.title}\n\n**Severity:** ${b.severity} · **Priority:** ${b.priority} · **Status:** ${b.status}\n`
    + (b.environment ? `**Environment:** ${b.environment}\n` : '')
    + (b.case_key ? `**Found by:** ${b.case_key} step ${b.step_no} (${b.cycle_key})\n` : '')
    + sec('Steps to reproduce', b.steps_to_reproduce) + sec('Expected result', b.expected) + sec('Actual result', b.actual)
    + (b.attachments.length ? `\n## Screenshots\n${b.attachments.map((a) => `- ${location.origin}/api/attachments/${a.id}`).join('\n')}\n` : '');
}

async function viewBug(id) {
  let b = await api('GET', `/api/bugs/${id}`);
  const integrations = await api('GET', `/api/projects/${b.project_id}/integrations`);
  const bugDefs = await api('GET', `/api/projects/${b.project_id}/fields?entity=bug`);
  const FIELDS = ['title', 'status', 'severity', 'priority', 'environment', 'steps_to_reproduce', 'expected', 'actual'];
  const read = () => ({ ...Object.fromEntries(FIELDS.map((f) => [f, $(`#b-${f}`).value])), assignee_id: $('#b-assignee_id').value ? Number($('#b-assignee_id').value) : null, fields: bugDefs.length ? readFields(view, bugDefs) : undefined });
  const render = () => {
    view.innerHTML = `
      <header class="head"><h1><span class="key">${esc(b.key)}</span> Bug</h1>
        <span><button class="btn danger" data-act="delete">${withIcon('trash', 'Delete')}</button> <button class="btn ghost" data-act="md">${withIcon('copy', 'Copy as Markdown')}</button>
        <button class="btn primary" data-act="save">${withIcon('save', 'Save')}</button></span></header>
      <p class="meta">${b.case_key ? `Found by ${b.case_id ? `<a href="#/cases/${b.case_id}">${esc(b.case_key)}</a>` : esc(b.case_key)} step ${b.step_no} in
        ${b.execution_id ? `<a href="#/run/${b.execution_id}">${esc(b.cycle_key)}</a>` : esc(b.cycle_key)} · ` : ''}Created ${fmtDate(b.created_at)}${b.reporter_name ? ` by ${esc(b.reporter_name)}` : ''} · Updated ${fmtDate(b.updated_at)}</p>
      <div class="links">${b.links.map((l) => `<a class="chip ext" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${icon('link')}<span>${esc(KIND_LABEL[l.kind] || l.kind)} ${esc(l.external_key)}${l.external_label || l.external_state ? ` · ${esc(l.external_label || l.external_state)}` : ''}</span></a>`).join('')}
        ${integrations.filter((i) => !b.links.some((l) => l.kind === i.kind)).map((i) => `<button type="button" class="btn small ghost" data-act="push" data-kind="${esc(i.kind)}">${withIcon('upload', `Send to ${esc(KIND_LABEL[i.kind] || i.kind)}`)}</button>`).join('')}${b.links.length ? `<button type="button" class="btn small ghost" data-act="sync" title="Check the linked issues now">${withIcon('rotate', 'Sync now')}</button>` : ''}</div>
      ${b.links.filter((l) => l.sync_error).map((l) => `<p class="warn">Could not sync with ${esc(KIND_LABEL[l.kind] || l.kind)} ${esc(l.external_key)}: ${esc(l.sync_error)}</p>`).join('')}
      <section class="card form">
        <label class="wide">Title<input id="b-title" value="${esc(b.title)}" maxlength="300"></label>
        <label>Status<select id="b-status">${options(['Open', 'In Progress', 'Resolved', 'Closed'], b.status)}</select></label>
        <label>Severity<select id="b-severity">${options(['Critical', 'Major', 'Minor', 'Trivial'], b.severity)}</select></label>
        <label>Priority<select id="b-priority">${options(['High', 'Medium', 'Low'], b.priority)}</select></label>
        <label>Assignee${userSelect('id="b-assignee_id"', b.assignee_id, b.assignee_name)}</label>
        <label class="wide">Environment<input id="b-environment" value="${esc(b.environment)}"></label>
        ${fieldInputs(bugDefs, b.fields, 'bf')}
        <label class="wide">Steps to reproduce<textarea id="b-steps_to_reproduce" rows="7" placeholder="1. …">${esc(b.steps_to_reproduce)}</textarea></label>
        <label>Expected result<textarea id="b-expected" rows="5">${esc(b.expected)}</textarea></label>
        <label>Actual result<textarea id="b-actual" rows="5">${esc(b.actual)}</textarea></label>
      </section>
      <section class="card"><h2>Screenshots</h2>
        <div class="shots large">${b.attachments.map((a) => attHtml(a, { removable: true, annotate: true })).join('')}
          <label class="btn small ghost">${withIcon('image', 'Add screenshot or file')}<input type="file" accept="${ACCEPT}" multiple hidden data-upload></label>
          <span class="muted">or paste (Ctrl+V)</span></div></section>
      <section class="card"><h2>Comments</h2>
        ${b.comments.length ? b.comments.map((c) => `<div class="comment"><div class="cmeta"><b>${esc(c.author || 'Former user')}</b> <span class="muted">${fmtDate(c.created_at)}</span>
          ${c.user_id === STATE.user.id || STATE.user.role === 'admin' ? `<button type="button" class="icon small danger" data-act="del-comment" data-id="${c.id}" aria-label="Delete comment" title="Delete comment">${icon('trash')}</button>` : ''}</div>
          <p class="pre">${esc(c.body)}</p></div>`).join('') : '<p class="muted">No comments yet.</p>'}
        <label>Add a comment<textarea id="b-new-comment" rows="3" maxlength="10000"></textarea></label>
        <p><button type="button" class="btn primary small" data-act="comment">${withIcon('plus', 'Comment')}</button></p></section>`;
  };
  const save = async () => { await api('PUT', `/api/bugs/${id}`, read()); };
  const reload = async () => { await save(); b = await api('GET', `/api/bugs/${id}`); render(); };
  const addShots = async (files) => {
    if (!files.length) return;
    try { await uploadImages(`/api/bugs/${id}/attachments`, files); await reload(); } catch (err) { fail(err); }
  };
  render();
  pasteHandler = addShots;
  view.onchange = (e) => { if (e.target.matches('[data-upload]')) addShots(filesFrom(e.target.files)); };
  view.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    try {
      if (t.dataset.act === 'save') { await reload(); toast('Bug saved'); }
      else if (t.dataset.act === 'md') { await navigator.clipboard.writeText(bugMarkdown({ ...b, ...read() })); toast('Bug report copied as Markdown'); }
      else if (t.dataset.act === 'rm-shot') { await api('DELETE', `/api/attachments/${t.dataset.id}`); await reload(); }
      else if (t.dataset.act === 'annotate') await openAnnotator(Number(t.dataset.id), reload);
      else if (t.dataset.act === 'sync') {
        t.disabled = true;
        try {
          await save();
          const r = await api('POST', `/api/bugs/${id}/sync`, {});
          const moved = r.links.filter((l) => l.changed), failed = r.links.filter((l) => l.error);
          toast(moved.length ? moved.map((l) => `${esc(l.key)} is ${esc(l.label)}: bug is now ${esc(l.to)}`).join('<br>') : failed.length ? `Could not reach ${failed.map((l) => esc(l.key)).join(', ')}` : 'Already up to date');
          b = await api('GET', `/api/bugs/${id}`);
          render();
        } catch (err) { t.disabled = false; throw err; }
      } else if (t.dataset.act === 'push') {
        t.disabled = true;
        try {
          await save();
          const r = await api('POST', `/api/bugs/${id}/push`, { kind: t.dataset.kind });
          toast(`Sent to ${esc(KIND_LABEL[t.dataset.kind])}: ${r.url ? `<a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">${esc(r.key)}</a>` : esc(r.key)}${r.note ? `<br><small>${esc(r.note)}</small>` : ''}`);
          b = await api('GET', `/api/bugs/${id}`);
          render();
        } catch (err) { t.disabled = false; throw err; }
      } else if (t.dataset.act === 'comment') {
        const text = $('#b-new-comment').value;
        if (!text.trim()) { $('#b-new-comment').focus(); return; }
        await api('POST', `/api/bugs/${id}/comments`, { body: text });
        await reload();
      } else if (t.dataset.act === 'del-comment') { await api('DELETE', `/api/bug-comments/${t.dataset.id}`); await reload(); }
      else if (t.dataset.act === 'delete') {
        if (!confirm(`Delete ${b.key} and its screenshots? It moves to Trash, where you can restore it.`)) return;
        const r = await api('DELETE', `/api/bugs/${id}`);
        location.hash = '#/bugs';
        deletedToast(b.key, r.trashId);
      }
    } catch (err) { fail(err); }
  };
}

const NAV_ICONS = { sso: 'key', webhooks: 'send', trash: 'trash', dash: 'home', cases: 'list', plans: 'plan', cycles: 'cycle', bugs: 'bug', reports: 'chart', users: 'users', integrations: 'plug', 'api-tokens': 'key', notifications: 'bell', 'email-settings': 'mail', 'custom-fields': 'sliders', audit: 'file' };
$$('#nav a').forEach((a) => { a.innerHTML = withIcon(NAV_ICONS[a.dataset.nav], a.textContent); });
$('#new-project').innerHTML = withIcon('plus', 'New project');

(async () => {
  try {
    const me = await (await fetch('/api/auth/me')).json();
    STATE.resetAvailable = !!me.resetAvailable;
    const reset = /^#\/reset\/([\w-]+)$/.exec(location.hash);
    if (reset && !me.user) { history.replaceState(null, '', location.pathname); renderReset(reset[1]); }
    else if (me.user) await startApp(me.user); else renderAuth(me.needsSetup);
  } catch (err) { fail(err); }
})();
