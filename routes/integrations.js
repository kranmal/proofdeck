'use strict';
// Per-project GitHub / Jira connections (admin) and "send this bug to…" (testers).

const secret = require('../lib/secret');
const { IntegrationError, validateBase, github, jira } = require('../lib/integrations');

const CLIENTS = { github, jira };
const inFlight = new Set();

function install(ctx) {
  const { route, q, tx, now, str, need, HttpError } = ctx;

  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, config TEXT NOT NULL, secret TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, kind)
    );
    CREATE TABLE IF NOT EXISTS bug_links (
      id INTEGER PRIMARY KEY, bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      external_key TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(bug_id, kind)
    );`);
  // Two-way sync bookkeeping.
  ctx.addColumn('bug_links', 'external_state', "TEXT NOT NULL DEFAULT ''"); // open | progress | done, as last seen
  ctx.addColumn('bug_links', 'external_label', "TEXT NOT NULL DEFAULT ''");
  ctx.addColumn('bug_links', 'synced_at', 'TEXT');
  ctx.addColumn('bug_links', 'sync_error', "TEXT NOT NULL DEFAULT ''");
  ctx.addColumn('integrations', 'webhook_secret', "TEXT NOT NULL DEFAULT ''");

  const wrap = (fn) => async (args) => {
    try { return await fn(args); } catch (e) {
      if (e instanceof IntegrationError) throw new HttpError(e.message.includes(' said: ') || /reached|timed out|redirected/.test(e.message) ? 502 : 400, e.message);
      throw e;
    }
  };

  function cleanConfig(kind, input) {
    const c = input && typeof input === 'object' ? input : {};
    const name = (v, label) => {
      const s = str(v).trim();
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(s)) throw new IntegrationError(`${label} looks wrong`);
      return s;
    };
    const labels = (Array.isArray(c.labels) ? c.labels : str(c.labels).split(',')).map((l) => str(l).trim()).filter(Boolean).slice(0, 10);
    if (labels.some((l) => l.length > 50)) throw new IntegrationError('Labels must be at most 50 characters');
    const sync = c.sync && typeof c.sync === 'object' ? c.sync : {};
    const syncCfg = {
      pull: sync.pull !== false, push: sync.push === true,
      onClose: ['Resolved', 'Closed'].includes(sync.onClose) ? sync.onClose : 'Resolved',
      onReopen: ['Open', 'In Progress'].includes(sync.onReopen) ? sync.onReopen : 'Open',
    };
    if (kind === 'github') {
      return { sync: syncCfg, base: validateBase(c.base || 'https://api.github.com', 'GitHub API URL'), owner: name(c.owner, 'Owner'), repo: name(c.repo, 'Repository'), labels: labels.length ? labels : ['bug'] };
    }
    const email = str(c.email).trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new IntegrationError('Enter the email address of the Jira account that owns the API token');
    const projectKey = str(c.projectKey).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(projectKey)) throw new IntegrationError('Jira project key looks wrong, e.g. PROJ');
    return { sync: syncCfg, base: validateBase(c.base, 'Jira site URL'), email, projectKey, issueType: str(c.issueType, 'Bug').trim().slice(0, 60) || 'Bug', labels };
  }

  const getRow = (pid, kind) => q('SELECT * FROM integrations WHERE project_id=? AND kind=?').get(pid, kind);
  function open(row) {
    const token = secret.decrypt(row.secret);
    if (token === null) throw new HttpError(409, 'The saved token cannot be decrypted (the secret key changed). Open Integrations and enter the token again.');
    return { cfg: JSON.parse(row.config), token };
  }
  ctx.integrations = { getRow, open, CLIENTS };
  const bugUrl = (bug) => (process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/#/bugs/${bug.id}` : '');

  route('GET', '/api/projects/:pid/integrations', ({ params }) => q('SELECT kind, config, updated_at FROM integrations WHERE project_id=? ORDER BY kind').all(params.pid)
    .map((r) => ({ kind: r.kind, config: JSON.parse(r.config), hasToken: true, updated_at: r.updated_at })));

  for (const kind of Object.keys(CLIENTS)) {
    route('PUT', `/api/projects/:pid/integrations/${kind}`, wrap(({ params, body }) => {
      need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
      const config = cleanConfig(kind, body.config);
      const existing = getRow(params.pid, kind);
      const token = str(body.token).trim();
      if (!token && !existing) throw new IntegrationError('An API token is required');
      const enc = token ? secret.encrypt(token) : existing.secret;
      q(`INSERT INTO integrations(project_id, kind, config, secret, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(project_id, kind) DO UPDATE SET config=excluded.config, secret=excluded.secret, updated_at=excluded.updated_at`)
        .run(params.pid, kind, JSON.stringify(config), enc, now());
      return { ok: true, config };
    }), { admin: true });

    route('DELETE', `/api/projects/:pid/integrations/${kind}`, ({ params }) => {
      q('DELETE FROM integrations WHERE project_id=? AND kind=?').run(params.pid, kind);
      return { ok: true };
    }, { admin: true });

    // Test with the values in the form (falls back to the saved token), without saving anything.
    route('POST', `/api/projects/:pid/integrations/${kind}/test`, wrap(async ({ params, body }) => {
      const config = cleanConfig(kind, body.config);
      let token = str(body.token).trim();
      if (!token) {
        const row = getRow(params.pid, kind);
        if (!row) throw new IntegrationError('Enter an API token to test with');
        token = open(row).token;
      }
      return { ok: true, message: await CLIENTS[kind].test(config, token) };
    }), { admin: true });
  }

  route('POST', '/api/bugs/:id/push', wrap(async ({ params, body, user }) => {
    const bug = need(q('SELECT * FROM bugs WHERE id=?').get(params.id), 'Bug');
    const kind = str(body.kind);
    if (!CLIENTS[kind]) throw new HttpError(400, 'Unknown integration');
    const row = getRow(bug.project_id, kind);
    if (!row) throw new HttpError(404, `${kind === 'github' ? 'GitHub' : 'Jira'} is not set up for this project. An admin can connect it under Integrations.`);
    const prior = q('SELECT external_key FROM bug_links WHERE bug_id=? AND kind=?').get(bug.id, kind);
    if (prior) throw new HttpError(409, `This bug was already sent (${prior.external_key})`);
    const lock = `${bug.id}:${kind}`;
    if (inFlight.has(lock)) throw new HttpError(409, 'This bug is already being sent');
    inFlight.add(lock);
    try {
      const { cfg, token } = open(row);
      const attachments = q("SELECT filename, mime, data FROM attachments WHERE owner_type='bug' AND owner_id=? ORDER BY id").all(bug.id)
        .map((a) => ({ ...a, data: Buffer.from(a.data) }));
      const made = await CLIENTS[kind].createIssue(cfg, token, bug, { bugUrl: bugUrl(bug), attachments });
      const link = /^https?:\/\//i.test(String(made.url)) ? made.url : '';
      tx(() => q("INSERT INTO bug_links(bug_id, kind, external_key, url, created_at, created_by, external_state, synced_at) VALUES (?,?,?,?,?,?,'open',?)")
        .run(bug.id, kind, made.key, link, now(), user.id, now()));
      const url = /^https?:\/\//i.test(String(made.url)) ? made.url : '';
      return { key: made.key, url, note: made.note || '' };
    } finally { inFlight.delete(lock); }
  }));
}

module.exports = { install };
