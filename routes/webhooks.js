'use strict';
// Outgoing webhooks: post a short message to Slack, Microsoft Teams or any URL when a run fails, a bug is raised or
// changes status, or a cycle is finished.
//
// Events are recorded by database triggers, so every way of changing data (the UI, CI uploads, Jira/GitHub sync)
// is covered without touching those code paths. A background worker turns events into deliveries, posts them with
// retries and records the outcome. A slow or broken endpoint never slows a request down.

const crypto = require('node:crypto');
const secret = require('../lib/secret');

const EVENTS = {
  'run.failed': 'A test run fails',
  'bug.created': 'A bug is created',
  'bug.status_changed': 'A bug changes status',
  'cycle.completed': 'Every run in a cycle is finished',
};
const KINDS = ['slack', 'teams', 'generic'];
const MAX_ATTEMPTS = 5;
const OPEN = "('Not Executed','In Progress')";

function install(ctx) {
  const { route, q, tx, db, now, str, need, HttpError, notifier } = ctx;
  const TICK = Number(process.env.WEBHOOK_TICK_MS) || 2000;
  const BACKOFF = process.env.WEBHOOK_BACKOFF_MS !== undefined ? Number(process.env.WEBHOOK_BACKOFF_MS) : 30000;

  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL, signing_secret TEXT NOT NULL DEFAULT '',
      events TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, entity_id INTEGER NOT NULL, project_id INTEGER, old_value TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY, webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, type TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, response_status INTEGER,
      last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, done_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_at);
  `);

  // Recreated on every start so a changed definition takes effect. They only write while a webhook exists.
  const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const live = 'EXISTS (SELECT 1 FROM webhooks WHERE active=1)';
  for (const t of ['run_failed', 'bug_created', 'bug_status', 'cycle_done']) db.exec(`DROP TRIGGER IF EXISTS trg_ev_${t}`);
  db.exec(`
    CREATE TRIGGER trg_ev_run_failed AFTER UPDATE OF status ON executions
    WHEN NEW.status='Fail' AND OLD.status!='Fail' AND ${live}
    BEGIN INSERT INTO events(type, entity_id, project_id, old_value, created_at)
      VALUES ('run.failed', NEW.id, (SELECT project_id FROM cycles WHERE id=NEW.cycle_id), OLD.status, ${stamp}); END;
    CREATE TRIGGER trg_ev_bug_created AFTER INSERT ON bugs WHEN ${live}
    BEGIN INSERT INTO events(type, entity_id, project_id, created_at) VALUES ('bug.created', NEW.id, NEW.project_id, ${stamp}); END;
    CREATE TRIGGER trg_ev_bug_status AFTER UPDATE OF status ON bugs WHEN NEW.status!=OLD.status AND ${live}
    BEGIN INSERT INTO events(type, entity_id, project_id, old_value, created_at) VALUES ('bug.status_changed', NEW.id, NEW.project_id, OLD.status, ${stamp}); END;
    CREATE TRIGGER trg_ev_cycle_done AFTER UPDATE OF status ON executions
    WHEN OLD.status IN ${OPEN} AND NEW.status NOT IN ${OPEN} AND ${live}
      AND (SELECT adhoc FROM cycles WHERE id=NEW.cycle_id)=0
      AND NOT EXISTS (SELECT 1 FROM executions WHERE cycle_id=NEW.cycle_id AND status IN ${OPEN})
    BEGIN INSERT INTO events(type, entity_id, project_id, created_at)
      VALUES ('cycle.completed', NEW.cycle_id, (SELECT project_id FROM cycles WHERE id=NEW.cycle_id), ${stamp}); END;
  `);

  // ----- what a message says -----
  const link = (path) => { const base = notifier.publicUrl(); return base ? `${base}/${path}` : ''; };
  function describe(ev) {
    if (ev.type === 'run.failed') {
      const r = q(`SELECT e.id, e.case_key, e.case_title, c.key AS cycle_key, c.name AS cycle_name, c.environment, c.build,
        COALESCE((SELECT display_name FROM users WHERE id=e.executed_by), NULLIF(e.executed_by_label, '')) AS by FROM executions e JOIN cycles c ON c.id=e.cycle_id WHERE e.id=?`).get(ev.entity_id);
      if (!r) return null;
      return { title: `Test failed: ${r.case_key} ${r.case_title}`, text: `in ${r.cycle_key} ${r.cycle_name}${r.build ? `, build ${r.build}` : ''}${r.environment ? `, ${r.environment}` : ''}${r.by ? `, run by ${r.by}` : ''}`, url: link(`#/run/${r.id}`), data: r };
    }
    if (ev.type === 'bug.created' || ev.type === 'bug.status_changed') {
      const b = q('SELECT b.id, b.key, b.title, b.severity, b.priority, b.status, (SELECT display_name FROM users WHERE id=b.reported_by) AS reporter, (SELECT display_name FROM users WHERE id=b.assignee_id) AS assignee FROM bugs b WHERE b.id=?').get(ev.entity_id);
      if (!b) return null;
      return ev.type === 'bug.created'
        ? { title: `New bug: ${b.key} ${b.title}`, text: `${b.severity} severity, ${b.priority} priority${b.reporter ? `, reported by ${b.reporter}` : ''}`, url: link(`#/bugs/${b.id}`), data: b }
        : { title: `${b.key} ${b.title}`, text: `moved from ${ev.old_value} to ${b.status}`, url: link(`#/bugs/${b.id}`), data: { ...b, from: ev.old_value, to: b.status } };
    }
    if (ev.type === 'cycle.completed') {
      const c = q('SELECT id, key, name, environment, build FROM cycles WHERE id=?').get(ev.entity_id);
      if (!c) return null;
      const n = q(`SELECT COUNT(*) AS total, COALESCE(SUM(status='Pass'),0) AS pass, COALESCE(SUM(status='Fail'),0) AS fail, COALESCE(SUM(status='Blocked'),0) AS blocked FROM executions WHERE cycle_id=?`).get(c.id);
      return { title: `Cycle finished: ${c.key} ${c.name}`, text: `${n.pass} passed, ${n.fail} failed, ${n.blocked} blocked of ${n.total}`, url: link(`#/cycles/${c.id}`), data: { ...c, ...n } };
    }
    return null;
  }

  function bodyFor(hook, type, d, project) {
    if (hook.kind === 'slack') return { text: `*${d.title}*\n${d.text}${d.url ? `\n<${d.url}|Open in Proofdeck>` : ''}` };
    if (hook.kind === 'teams') {
      return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [{ type: 'TextBlock', text: d.title, weight: 'Bolder', wrap: true }, { type: 'TextBlock', text: d.text, wrap: true }],
        actions: d.url ? [{ type: 'Action.OpenUrl', title: 'Open in Proofdeck', url: d.url }] : [] } }] };
    }
    return { event: type, at: now(), project: { id: project.id, key: project.key, name: project.name }, title: d.title, text: d.text, url: d.url || null, data: d.data };
  }

  const hookView = (h) => {
    let host = '';
    try { host = new URL(secret.decrypt(h.url)).host; } catch { /* unreadable */ }
    return { id: h.id, name: h.name, kind: h.kind, host, events: JSON.parse(h.events), active: !!h.active, signed: !!h.signing_secret,
      last: q('SELECT status, response_status, last_error, created_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 1').get(h.id) || null };
  };
  const cleanUrl = (v) => {
    let u;
    try { u = new URL(str(v).trim()); } catch { throw new HttpError(400, 'That is not a valid web address'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'The address must start with http:// or https://');
    if (u.username || u.password) throw new HttpError(400, 'Put keys in the path or query of the address, not as user:password@');
    return u.toString();
  };
  const cleanEvents = (v) => {
    const list = [...new Set((Array.isArray(v) ? v : []).map(String))].filter((e) => EVENTS[e]);
    if (!list.length) throw new HttpError(400, 'Choose at least one event');
    return list;
  };

  // ----- routes (admins) -----
  route('GET', '/api/projects/:pid/webhooks', ({ params }) => ({
    events: EVENTS, kinds: KINDS, items: q('SELECT * FROM webhooks WHERE project_id=? ORDER BY id').all(params.pid).map(hookView),
  }), { admin: true });

  route('POST', '/api/projects/:pid/webhooks', ({ params, body }) => {
    need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
    const name = str(body.name).trim().slice(0, 80), kind = str(body.kind);
    if (!name) throw new HttpError(400, 'Give it a name');
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Choose Slack, Teams or a generic webhook');
    if (q('SELECT COUNT(*) n FROM webhooks WHERE project_id=?').get(params.pid).n >= 20) throw new HttpError(400, 'A project can have up to 20 webhooks');
    const id = Number(q('INSERT INTO webhooks(project_id, name, kind, url, signing_secret, events, active, created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(params.pid, name, kind, secret.encrypt(cleanUrl(body.url)), kind === 'generic' && str(body.signingSecret) ? secret.encrypt(str(body.signingSecret).slice(0, 200)) : '', JSON.stringify(cleanEvents(body.events)), now()).lastInsertRowid);
    return { id };
  }, { admin: true });

  route('PUT', '/api/webhooks/:id', ({ params, body }) => {
    const h = need(q('SELECT * FROM webhooks WHERE id=?').get(params.id), 'Webhook');
    const sets = [], vals = [];
    if (body.name !== undefined) { const n = str(body.name).trim().slice(0, 80); if (!n) throw new HttpError(400, 'Give it a name'); sets.push('name=?'); vals.push(n); }
    if (body.url) { sets.push('url=?'); vals.push(secret.encrypt(cleanUrl(body.url))); } // blank keeps the stored address
    if (body.events !== undefined) { sets.push('events=?'); vals.push(JSON.stringify(cleanEvents(body.events))); }
    if (body.active !== undefined) { sets.push('active=?'); vals.push(body.active ? 1 : 0); }
    if (h.kind === 'generic' && body.signingSecret !== undefined) { sets.push('signing_secret=?'); vals.push(str(body.signingSecret) ? secret.encrypt(str(body.signingSecret).slice(0, 200)) : ''); }
    if (sets.length) q(`UPDATE webhooks SET ${sets.join(',')} WHERE id=?`).run(...vals, h.id);
    return { ok: true };
  }, { admin: true });

  route('DELETE', '/api/webhooks/:id', ({ params }) => { q('DELETE FROM webhooks WHERE id=?').run(params.id); return { ok: true }; }, { admin: true });

  route('GET', '/api/webhooks/:id/deliveries', ({ params }) => {
    need(q('SELECT 1 FROM webhooks WHERE id=?').get(params.id), 'Webhook');
    return q('SELECT id, type, status, attempts, response_status, last_error, created_at, done_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 30').all(params.id);
  }, { admin: true });

  route('POST', '/api/webhooks/:id/test', ({ params }) => {
    const h = need(q('SELECT * FROM webhooks WHERE id=?').get(params.id), 'Webhook');
    const project = q('SELECT id, key, name FROM projects WHERE id=?').get(h.project_id);
    const d = { title: 'Test from Proofdeck', text: 'If you can read this, the webhook works.', url: link('#/'), data: { test: true } };
    q('INSERT INTO webhook_deliveries(webhook_id, type, body, next_at, created_at) VALUES (?,?,?,?,?)').run(h.id, 'test', JSON.stringify(bodyFor(h, 'test', d, project)), now(), now());
    setImmediate(tick);
    return { ok: true };
  }, { admin: true });

  // ----- worker -----
  let busy = false;
  const cursor = () => Number(notifier.settings('webhook_cursor') || 0);
  const setCursor = (n) => q('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('webhook_cursor', String(n));

  function fanOut() {
    const evs = q('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 200').all(cursor());
    for (const ev of evs) {
      tx(() => {
        const hooks = q('SELECT * FROM webhooks WHERE active=1 AND project_id=?').all(ev.project_id).filter((h) => JSON.parse(h.events).includes(ev.type));
        const d = hooks.length ? describe(ev) : null;
        if (d) {
          const project = q('SELECT id, key, name FROM projects WHERE id=?').get(ev.project_id);
          for (const h of hooks) q('INSERT INTO webhook_deliveries(webhook_id, type, body, next_at, created_at) VALUES (?,?,?,?,?)').run(h.id, ev.type, JSON.stringify(bodyFor(h, ev.type, d, project)), now(), now());
        }
        setCursor(ev.id);
      });
    }
  }

  async function deliver(d) {
    const h = q('SELECT * FROM webhooks WHERE id=?').get(d.webhook_id);
    let status = null, error = '';
    try {
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Proofdeck-Webhook', 'X-Proofdeck-Event': d.type };
      if (h.signing_secret) headers['X-Proofdeck-Signature'] = `sha256=${crypto.createHmac('sha256', secret.decrypt(h.signing_secret)).update(d.body).digest('hex')}`;
      const res = await fetch(secret.decrypt(h.url), { method: 'POST', headers, body: d.body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      status = res.status;
      await res.arrayBuffer().catch(() => {});
      if (res.status < 200 || res.status >= 300) error = `The other side answered ${res.status}`;
    } catch (e) { error = e.name === 'TimeoutError' ? 'No answer within 10 seconds' : `Could not connect: ${e.cause && e.cause.code ? e.cause.code : e.message}`; }
    const attempts = d.attempts + 1;
    if (!error) q("UPDATE webhook_deliveries SET status='ok', attempts=?, response_status=?, last_error='', done_at=? WHERE id=?").run(attempts, status, now(), d.id);
    else if (attempts >= MAX_ATTEMPTS) q("UPDATE webhook_deliveries SET status='failed', attempts=?, response_status=?, last_error=?, done_at=? WHERE id=?").run(attempts, status, error, now(), d.id);
    else q('UPDATE webhook_deliveries SET attempts=?, response_status=?, last_error=?, next_at=? WHERE id=?').run(attempts, status, error, new Date(Date.now() + BACKOFF * 4 ** (attempts - 1)).toISOString(), d.id);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      fanOut();
      for (const d of q("SELECT * FROM webhook_deliveries WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 20").all(now())) await deliver(d);
    } catch (e) { console.error('webhook worker:', e.message); } finally { busy = false; }
  }
  const tidy = () => {
    q('DELETE FROM events WHERE id<=? AND created_at<?').run(cursor(), new Date(Date.now() - 86400000).toISOString());
    q("DELETE FROM webhook_deliveries WHERE status!='pending' AND created_at<?").run(new Date(Date.now() - 7 * 86400000).toISOString());
  };
  tidy();
  setInterval(tick, TICK).unref();
  setInterval(tidy, 3600000).unref();
}

module.exports = { install };
