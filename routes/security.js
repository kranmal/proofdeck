'use strict';
// Who did what: an audit log of changes, a sign-in history, and session management (list / sign out elsewhere).
// The audit log is written centrally by the request dispatcher, so every change is covered without per-route code.

const KEEP_AUDIT_DAYS = () => Math.min(3650, Math.max(30, Number(process.env.AUDIT_KEEP_DAYS) || 365));
const KEEP_LOGIN_DAYS = () => Math.min(3650, Math.max(30, Number(process.env.LOGIN_KEEP_DAYS) || 180));

// Friendly names for the changes worth reading about. Anything not listed (and not excluded) is logged as "METHOD /path".
const LABELS = {
  'POST /api/auth/setup': 'First admin account created',
  'POST /api/auth/password': 'Password changed',
  'PUT /api/settings/oidc': 'Single sign-on settings changed',
  'POST /api/auth/2fa/enable': 'Two-factor sign-in turned on',
  'POST /api/auth/2fa/disable': 'Two-factor sign-in turned off',
  'POST /api/users/:id/2fa-reset': 'Two-factor sign-in reset by an admin',
  'POST /api/users': 'User created',
  'PUT /api/users/:id': 'User changed',
  'POST /api/users/:id/sign-out': 'User signed out everywhere',
  'POST /api/projects': 'Project created',
  'POST /api/projects/:pid/api-tokens': 'API token created',
  'DELETE /api/api-tokens/:id': 'API token revoked',
  'PUT /api/settings/notifications': 'Email settings changed',
  'DELETE /api/cases/:id': 'Test case deleted',
  'POST /api/projects/:pid/cases/bulk': 'Test cases changed in bulk',
  'POST /api/projects/:pid/bugs/bulk': 'Bugs changed in bulk',
  'DELETE /api/cycles/:id': 'Test cycle deleted',
  'DELETE /api/bugs/:id': 'Bug deleted',
  'DELETE /api/plans/:id': 'Test plan deleted',
  'POST /api/cases/:id/review': 'Test case review',
  'PUT /api/projects/:pid/workflow': 'Approval workflow changed',
  'POST /api/ci/results': 'CI results received',
  'POST /api/ci/junit': 'CI JUnit results received',
};
// Too frequent or too small to be worth a line: running tests, notification housekeeping, own profile and session actions.
const SKIP = [/^\/api\/step-results\b/, /^\/api\/executions\b/, /^\/api\/attachments\b/, /^\/api\/notifications\b/, /^\/api\/auth\/(?!setup|password|2fa\/(?:enable|disable))/, /\/run$/, /\/comments$/, /^\/api\/step-results/];
// Only these request fields are ever copied into the log: never passwords, tokens or secrets.
const SAFE = ['username', 'display_name', 'role', 'active', 'name', 'title', 'status', 'severity', 'priority', 'action', 'key', 'kind', 'mode', 'scope', 'type', 'enabled', 'strict'];

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (process.env.TRUST_PROXY === '1') ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || ip;
  return ip.replace(/^::ffff:/, '').slice(0, 64);
}

function install(ctx) {
  const { route, q, db, now, str, HttpError, addColumn } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id INTEGER, actor_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, project_id INTEGER, detail TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS audit_at ON audit_log(id DESC);
  CREATE TABLE IF NOT EXISTS login_events (
    id INTEGER PRIMARY KEY, at TEXT NOT NULL, username TEXT NOT NULL, user_id INTEGER, ok INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS login_at ON login_events(id DESC)`);
  addColumn('sessions', 'ip', "TEXT NOT NULL DEFAULT ''");
  addColumn('sessions', 'user_agent', "TEXT NOT NULL DEFAULT ''");
  addColumn('sessions', 'last_seen_at', 'TEXT');

  const prune = () => {
    q('DELETE FROM audit_log WHERE at < ?').run(new Date(Date.now() - KEEP_AUDIT_DAYS() * 86400000).toISOString());
    q('DELETE FROM login_events WHERE at < ?').run(new Date(Date.now() - KEEP_LOGIN_DAYS() * 86400000).toISOString());
  };
  prune();
  setInterval(() => { try { prune(); } catch { /* retry next time */ } }, 6 * 3600 * 1000).unref();

  const detailOf = (body, out, pattern) => {
    const parts = [];
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      for (const k of SAFE) if (body[k] !== undefined && (typeof body[k] !== 'object' || body[k] === null)) parts.push(`${k}: ${String(body[k]).slice(0, 80)}`);
      if (body.password) parts.push('password: reset');
      if (Array.isArray(body.ids)) parts.push(`${body.ids.length} selected`);
      if (body.fields && typeof body.fields === 'object') parts.push(`fields: ${Object.keys(body.fields).slice(0, 8).join(', ')}`);
    }
    if (out && typeof out === 'object' && !(out instanceof ctx.Raw) && Number.isInteger(out.id) && pattern.startsWith('POST')) parts.push(`id ${out.id}`);
    return parts.join(' · ').slice(0, 400);
  };

  // Called by the dispatcher after any successful request. Never throws: logging must not break the action itself.
  ctx.security.audit = ({ method, pattern, path, params, body, user, token, req, out }) => {
    try {
      if (method === 'GET') return;
      if (SKIP.some((re) => re.test(path))) return;
      const key = `${method} ${pattern}`;
      q('INSERT INTO audit_log(at, actor_kind, actor_id, actor_name, action, method, path, project_id, detail, ip) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        now(), token ? 'token' : user ? 'user' : 'system', user ? user.id : null, token ? `API token “${token.name}”` : user ? user.display_name : '',
        LABELS[key] || key, method, path, params.pid || null, detailOf(body, out, key), clientIp(req));
    } catch (e) { console.error('audit failed:', e.message); }
  };

  ctx.security.loginEvent = (req, { username, userId = null, ok, reason = '' }) => {
    try {
      q('INSERT INTO login_events(at, username, user_id, ok, reason, ip, user_agent) VALUES (?,?,?,?,?,?,?)')
        .run(now(), str(username).slice(0, 80), userId, ok ? 1 : 0, reason, clientIp(req), str(req.headers['user-agent']).slice(0, 200));
    } catch (e) { console.error('login event failed:', e.message); }
  };
  ctx.security.clientIp = clientIp;

  const page = (query) => ({
    limit: Math.min(200, Math.max(1, Number(query.get('limit')) || 50)),
    before: Number(query.get('before')) || 0,
  });

  route('GET', '/api/audit', ({ query }) => {
    const { limit, before } = page(query);
    const where = [], args = [];
    if (before) { where.push('id < ?'); args.push(before); }
    const text = str(query.get('q')).trim().slice(0, 80);
    if (text) { where.push("(action LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')"); const like = `%${text.replace(/[\\%_]/g, '\\$&')}%`; args.push(like, like, like, like); }
    const actor = Number(query.get('actor')) || 0;
    if (actor) { where.push('actor_id = ?'); args.push(actor); }
    for (const [k, op] of [['from', '>='], ['to', '<=']]) {
      const v = str(query.get(k)).trim();
      if (v) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `“${k}” must be a date (YYYY-MM-DD)`);
        where.push(`date(at) ${op} ?`); args.push(v);
      }
    }
    const items = q(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
    const more = items.length > limit;
    return { items: items.slice(0, limit), next: more ? items[limit - 1].id : null };
  }, { admin: true });

  route('GET', '/api/login-events', ({ query }) => {
    const { limit, before } = page(query);
    const where = [], args = [];
    if (before) { where.push('id < ?'); args.push(before); }
    if (query.get('fails') === '1') where.push('ok = 0');
    const items = q(`SELECT * FROM login_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
    const more = items.length > limit;
    return { items: items.slice(0, limit), next: more ? items[limit - 1].id : null };
  }, { admin: true });

  // ---- your own sessions and sign-in history
  route('GET', '/api/auth/sessions', ({ user }) => q('SELECT rowid AS id, token_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id=? AND expires_at>? ORDER BY COALESCE(last_seen_at, created_at) DESC')
    .all(user.id, now()).map(({ token_hash, ...s }) => ({ ...s, current: token_hash === user._sid })), { viewer: true });

  route('DELETE', '/api/auth/sessions/:id', ({ params, user }) => {
    const r = q('DELETE FROM sessions WHERE rowid=? AND user_id=? AND token_hash!=?').run(params.id, user.id, user._sid);
    if (!r.changes) throw new HttpError(404, 'Session not found. To end this one, use Sign out.');
    return { ok: true };
  }, { viewer: true });

  route('POST', '/api/auth/sessions/revoke-others', ({ user }) => ({ count: Number(q('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, user._sid).changes) }), { viewer: true });

  route('GET', '/api/auth/history', ({ user }) => q('SELECT at, ok, reason, ip, user_agent FROM login_events WHERE user_id=? OR (user_id IS NULL AND username=? COLLATE NOCASE) ORDER BY id DESC LIMIT 20')
    .all(user.id, user.username), { viewer: true });

  route('POST', '/api/users/:id/sign-out', ({ params }) => {
    ctx.need(q('SELECT 1 FROM users WHERE id=?').get(params.id), 'User');
    return { count: Number(q('DELETE FROM sessions WHERE user_id=?').run(params.id).changes) };
  }, { admin: true });
}

module.exports = { install, clientIp };
