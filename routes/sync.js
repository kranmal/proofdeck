'use strict';
// Two-way status sync between bugs and their issues in Jira, GitHub, Linear, Azure DevOps and GitLab.
//   pull: a poller (always on), a "Sync now" button and webhooks (optional, instant) update the bug when the issue changes
//   push: changing a bug's status in Proofdeck closes or reopens the issue (opt-in per integration)
// Changes are applied only when the external state differs from the last one we saw, so a local edit is never
// undone by an old value, and a push never echoes back as a pull.

const crypto = require('node:crypto');
const secret = require('../lib/secret');
const { Limiter } = require('../lib/auth');
const live = require('../lib/live');

const LABEL = { github: 'GitHub', jira: 'Jira', linear: 'Linear', azure: 'Azure DevOps', gitlab: 'GitLab' };
const CLOSED = ['Resolved', 'Closed'];
const extOf = (status) => (CLOSED.includes(status) ? 'done' : status === 'In Progress' ? 'progress' : 'open');

function install(ctx) {
  const { route, q, db, now, str, need, HttpError, notifier } = ctx;
  const { getRow, open, CLIENTS } = ctx.integrations;
  const SYNC_TICK_MS = Number(process.env.SYNC_TICK_MS) || 5 * 60000;
  const syncOf = (cfg) => ({ pull: true, push: false, onClose: 'Resolved', onReopen: 'Open', ...(cfg.sync || {}) });

  const LINK_SQL = `SELECT l.*, b.status AS bug_status, b.project_id, b.key AS bug_key, b.title AS bug_title, b.reported_by, b.assignee_id
    FROM bug_links l JOIN bugs b ON b.id=l.bug_id`;

  // The bug changes because the issue did. Returns what happened.
  function applyExternal(linkId, state, label) {
    const link = q(`${LINK_SQL} WHERE l.id=?`).get(linkId);
    const prev = link.external_state;
    q("UPDATE bug_links SET external_state=?, external_label=?, synced_at=?, sync_error='' WHERE id=?").run(state, label, now(), linkId);
    if (prev === state) return { changed: false };
    const row = getRow(link.project_id, link.kind);
    if (!row || !syncOf(JSON.parse(row.config)).pull) return { changed: false, ignored: true };
    const s = syncOf(JSON.parse(row.config));
    const closed = CLOSED.includes(link.bug_status);
    let target = null;
    if (state === 'done' && !closed) target = s.onClose;
    else if (state === 'open' && closed) target = s.onReopen;
    else if (state === 'progress' && (link.bug_status === 'Open' || closed)) target = 'In Progress';
    if (!target || target === link.bug_status) return { changed: false };
    q('UPDATE bugs SET status=?, updated_at=? WHERE id=?').run(target, now(), link.bug_id);
    live.publish({ topic: 'bugs', pid: link.project_id });
    q('INSERT INTO bug_comments(bug_id, user_id, body, created_at) VALUES (?,NULL,?,?)')
      .run(link.bug_id, `Status changed from ${link.bug_status} to ${target} because ${link.external_key} is now “${label}” in ${LABEL[link.kind]}.`, now());
    for (const uid of new Set([link.reported_by, link.assignee_id])) {
      if (uid) notifier.notify(uid, { kind: 'bug-status', title: `${link.bug_key} is now ${target}`, body: `${link.external_key} changed to “${label}” in ${LABEL[link.kind]}.`, link: `#/bugs/${link.bug_id}`, projectId: link.project_id });
    }
    return { changed: true, from: link.bug_status, to: target };
  }

  async function pullOne(link) {
    const row = getRow(link.project_id, link.kind);
    if (!row) return { kind: link.kind, key: link.external_key, skipped: 'not connected' };
    try {
      const { cfg, token } = open(row);
      const st = await CLIENTS[link.kind].getState(cfg, token, link.external_key);
      return { kind: link.kind, key: link.external_key, state: st.state, label: st.label, ...applyExternal(link.id, st.state, st.label) };
    } catch (e) {
      const msg = String(e.message).slice(0, 300);
      q('UPDATE bug_links SET synced_at=?, sync_error=? WHERE id=?').run(now(), msg, link.id);
      return { kind: link.kind, key: link.external_key, error: msg };
    }
  }

  // ---------- push ----------
  function statusChanged(bug, from, to, user) {
    if (extOf(from) === extOf(to) && !(to === 'In Progress' && from !== 'In Progress')) return;
    for (const link of q('SELECT * FROM bug_links WHERE bug_id=?').all(bug.id)) {
      const row = getRow(bug.project_id, link.kind);
      if (!row || !syncOf(JSON.parse(row.config)).push) continue;
      const want = extOf(to);
      if (['github', 'gitlab'].includes(link.kind) && want === 'progress') continue; // these issues are simply open or closed
      if (link.external_state === want) continue;
      setImmediate(async () => {
        try {
          const { cfg, token } = open(row);
          const res = await CLIENTS[link.kind].setState(cfg, token, link.external_key, want);
          q("UPDATE bug_links SET external_state=?, external_label=?, synced_at=?, sync_error='' WHERE id=?").run(res.state, res.label, now(), link.id);
        } catch (e) {
          q('UPDATE bug_links SET synced_at=?, sync_error=? WHERE id=?').run(now(), String(e.message).slice(0, 300), link.id);
          if (user) notifier.notify(user.id, { kind: 'sync-error', title: `Could not update ${link.external_key} in ${LABEL[link.kind]}`, body: String(e.message).slice(0, 300), link: `#/bugs/${bug.id}`, projectId: bug.project_id });
        }
      });
    }
  }
  ctx.syncHooks.statusChanged = statusChanged;

  // ---------- routes ----------
  route('POST', '/api/bugs/:id/sync', async ({ params }) => {
    const bug = need(q('SELECT id FROM bugs WHERE id=?').get(params.id), 'Bug');
    const links = q(`${LINK_SQL} WHERE l.bug_id=?`).all(bug.id);
    if (!links.length) throw new HttpError(400, 'This bug has not been sent to Jira or GitHub');
    const out = [];
    for (const l of links) out.push(await pullOne(l));
    return { links: out };
  });

  async function pullProject(pid, limit = 200) {
    const links = q(`${LINK_SQL} WHERE b.project_id=? AND b.status!='Closed' ORDER BY l.synced_at IS NOT NULL, l.synced_at LIMIT ?`).all(pid, limit);
    const sum = { checked: 0, changed: 0, errors: 0 };
    for (const l of links) {
      const row = getRow(pid, l.kind);
      if (!row || !syncOf(JSON.parse(row.config)).pull) continue;
      const r = await pullOne(l);
      sum.checked++;
      if (r.changed) sum.changed++;
      if (r.error) sum.errors++;
    }
    return sum;
  }
  route('POST', '/api/projects/:pid/sync', async ({ params }) => pullProject(params.pid), { admin: true });

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { for (const p of q('SELECT DISTINCT project_id FROM integrations').all()) await pullProject(p.project_id, 50); }
    catch (e) { console.error('bug sync:', e.message); } finally { busy = false; }
  }, SYNC_TICK_MS).unref();

  // ---------- webhooks (optional, for instant updates) ----------
  const bad = new Limiter();
  const secretOf = (row) => (row && row.webhook_secret ? secret.decrypt(row.webhook_secret) : null);
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const hmac = (key, raw) => crypto.createHmac('sha256', key).update(raw).digest('hex');
  const findLink = (pid, kind, key) => q(`${LINK_SQL} WHERE b.project_id=? AND l.kind=? AND l.external_key=? COLLATE NOCASE`).get(pid, kind, key);

  // A genuine call always gets through; only invalid ones are throttled.
  function verify(req, query, row, raw) {
    const key = secretOf(row);
    const sig = String(req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'] || req.headers['linear-signature'] || '').replace(/^sha256=/, '');
    // GitLab sends the secret as it is; Azure DevOps service hooks can send it as the password of Basic auth.
    const plain = String(req.headers['x-gitlab-token'] || '');
    const basic = /^Basic /i.test(req.headers.authorization || '') ? Buffer.from(String(req.headers.authorization).slice(6), 'base64').toString().replace(/^[^:]*:/, '') : '';
    if (key && ((sig && safeEq(sig, hmac(key, raw))) || (plain && safeEq(plain, key)) || (basic && safeEq(basic, key)) || (query.get('secret') && safeEq(query.get('secret'), key)))) return;
    const ip = req.socket.remoteAddress || '';
    const wait = bad.blocked(ip);
    if (wait) throw new HttpError(429, 'Too many invalid webhook calls');
    bad.fail(ip);
    throw new HttpError(401, 'Invalid webhook signature or secret');
  }
  const parse = (raw) => { try { return JSON.parse(raw); } catch { throw new HttpError(400, 'The body is not valid JSON'); } };

  route('POST', '/api/webhooks/github/:pid', ({ params, body, query, req }) => {
    const row = getRow(params.pid, 'github');
    verify(req, query, row, body);
    const event = req.headers['x-github-event'];
    if (event === 'ping') return { ok: true, pong: true };
    if (event !== 'issues') return { ok: true, ignored: `event ${event}` };
    const p = parse(body), cfg = JSON.parse(row.config);
    if (String(p.repository && p.repository.full_name).toLowerCase() !== `${cfg.owner}/${cfg.repo}`.toLowerCase()) return { ok: true, ignored: 'another repository' };
    if (!['closed', 'reopened'].includes(p.action)) return { ok: true, ignored: `action ${p.action}` };
    const link = p.issue && findLink(params.pid, 'github', `#${p.issue.number}`);
    if (!link) return { ok: true, ignored: 'no bug is linked to this issue' };
    const label = p.action === 'closed' ? `closed${p.issue.state_reason ? ` (${p.issue.state_reason})` : ''}` : 'open';
    return { ok: true, ...applyExternal(link.id, p.action === 'closed' ? 'done' : 'open', label) };
  }, { public: true, raw: true });

  route('POST', '/api/webhooks/jira/:pid', ({ params, body, query, req }) => {
    const row = getRow(params.pid, 'jira');
    verify(req, query, row, body);
    const p = parse(body);
    const issue = p.issue;
    const st = issue && issue.fields && issue.fields.status;
    if (!issue || !st) return { ok: true, ignored: 'not an issue update' };
    const link = findLink(params.pid, 'jira', issue.key);
    if (!link) return { ok: true, ignored: 'no bug is linked to this issue' };
    const cat = st.statusCategory && st.statusCategory.key;
    return { ok: true, ...applyExternal(link.id, cat === 'done' ? 'done' : cat === 'indeterminate' ? 'progress' : 'open', st.name || cat || 'unknown') };
  }, { public: true, raw: true });

  route('POST', '/api/webhooks/linear/:pid', ({ params, body, query, req }) => {
    const row = getRow(params.pid, 'linear');
    verify(req, query, row, body);
    const p = parse(body), cfg = JSON.parse(row.config);
    if (p.webhookTimestamp && Math.abs(Date.now() - Number(p.webhookTimestamp)) > 5 * 60000) return { ok: true, ignored: 'too old' }; // replay guard
    if (p.type !== 'Issue' || p.action !== 'update' || !p.data || !p.data.state) return { ok: true, ignored: `${p.type || 'event'} ${p.action || ''}`.trim() };
    const team = p.data.team && p.data.team.key;
    if (team && String(team).toUpperCase() !== String(cfg.teamKey).toUpperCase()) return { ok: true, ignored: 'another team' };
    const key = p.data.identifier || (team && p.data.number ? `${team}-${p.data.number}` : '');
    const link = key && findLink(params.pid, 'linear', key);
    if (!link) return { ok: true, ignored: 'no bug is linked to this issue' };
    const t = p.data.state.type;
    return { ok: true, ...applyExternal(link.id, ['completed', 'canceled'].includes(t) ? 'done' : t === 'started' ? 'progress' : 'open', p.data.state.name || t) };
  }, { public: true, raw: true });

  // Azure DevOps: a "Work item updated" service hook. The event only says which item changed; the state's category
  // (proposed / in progress / done) comes from the workflow, so we ask Azure for it instead of guessing from the name.
  route('POST', '/api/webhooks/azure/:pid', async ({ params, body, query, req }) => {
    const row = getRow(params.pid, 'azure');
    verify(req, query, row, body);
    const p = parse(body), cfg = JSON.parse(row.config);
    if (p.eventType === 'ping' || /^(git|build|ms\.vss)/.test(p.eventType || '')) return { ok: true, ignored: `event ${p.eventType}` };
    if (p.eventType !== 'workitem.updated' || !p.resource) return { ok: true, ignored: `event ${p.eventType}` };
    const r = p.resource, fields = (r.revision && r.revision.fields) || {};
    const proj = fields['System.TeamProject'];
    if (proj && String(proj).toLowerCase() !== String(cfg.project).toLowerCase()) return { ok: true, ignored: 'another project' };
    if (!(r.fields && r.fields['System.State'])) return { ok: true, ignored: 'the state did not change' };
    const link = findLink(params.pid, 'azure', String(r.workItemId || r.id));
    if (!link) return { ok: true, ignored: 'no bug is linked to this item' };
    const out = await pullOne(link);
    return out.error ? { ok: true, error: out.error } : { ok: true, changed: out.changed, state: out.state };
  }, { public: true, raw: true });

  route('POST', '/api/webhooks/gitlab/:pid', ({ params, body, query, req }) => {
    const row = getRow(params.pid, 'gitlab');
    verify(req, query, row, body);
    const p = parse(body), cfg = JSON.parse(row.config);
    if (p.object_kind !== 'issue' || !p.object_attributes) return { ok: true, ignored: `event ${p.object_kind || 'unknown'}` };
    const path = p.project && p.project.path_with_namespace;
    if (path && /\//.test(cfg.project) && path.toLowerCase() !== String(cfg.project).toLowerCase()) return { ok: true, ignored: 'another project' };
    const a = p.object_attributes;
    if (!['close', 'reopen'].includes(a.action)) return { ok: true, ignored: `action ${a.action}` };
    const link = findLink(params.pid, 'gitlab', `#${a.iid}`);
    if (!link) return { ok: true, ignored: 'no bug is linked to this issue' };
    return { ok: true, ...applyExternal(link.id, a.action === 'close' ? 'done' : 'open', a.action === 'close' ? 'closed' : 'opened') };
  }, { public: true, raw: true });

  // Admin: the address to register and its secret (created on first request, kept encrypted).
  for (const kind of ['github', 'jira', 'linear', 'azure', 'gitlab']) {
    const info = (pid, regenerate) => {
      const row = need(getRow(pid, kind), `${LABEL[kind]} is not connected for this project`);
      let key = regenerate ? null : secretOf(row);
      if (!key) {
        key = crypto.randomBytes(24).toString('base64url');
        q('UPDATE integrations SET webhook_secret=? WHERE project_id=? AND kind=?').run(secret.encrypt(key), pid, kind);
      }
      const base = (notifier.publicUrl() || '').replace(/\/+$/, '');
      return { path: `/api/webhooks/${kind}/${pid}`, url: base ? `${base}/api/webhooks/${kind}/${pid}` : '', secret: key };
    };
    route('GET', `/api/projects/:pid/integrations/${kind}/webhook`, ({ params }) => info(params.pid, false), { admin: true });
    route('POST', `/api/projects/:pid/integrations/${kind}/webhook`, ({ params }) => info(params.pid, true), { admin: true });
  }
}

module.exports = { install };
