'use strict';
// API tokens for CI. A token belongs to one project and may only call the /api/ci endpoints.
// Only a SHA-256 hash is stored; the token itself is shown once, when it is created.

const crypto = require('node:crypto');
const { Limiter } = require('../lib/auth');

let ctx;
const failures = new Limiter();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const MAX_TOKENS = 50;

// Returns { id, project_id, name } for a valid "Authorization: Bearer pd_…" header, or throws 401/429.
// Only invalid attempts are throttled: a valid token always works, so typos elsewhere on a shared CI address
// can never lock the real pipelines out. Tokens are 240 random bits, so guessing one is not a practical risk.
function authenticate(req) {
  const { q, now, HttpError } = ctx;
  const m = /^Bearer\s+(pd_[A-Za-z0-9_-]{20,})\s*$/.exec(req.headers.authorization || '');
  const row = m && q('SELECT id, project_id, name, last_used_at, expires_at, scope FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL').get(sha(m[1]));
  if (row) {
    if (row.expires_at && row.expires_at <= now()) throw new HttpError(401, `This API token expired on ${row.expires_at.slice(0, 10)}. Create a new one.`);
    if (row.scope === 'read' && req.method !== 'GET') throw new HttpError(403, 'This API token is read-only: it can check results but not send them.');
    if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60000) q('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(now(), row.id);
    return { id: row.id, project_id: row.project_id, name: row.name, scope: row.scope };
  }
  const ip = req.socket.remoteAddress || '';
  const wait = failures.blocked(ip);
  if (wait) throw new HttpError(429, `Too many invalid tokens. Try again in ${wait} seconds.`);
  failures.fail(ip);
  throw new HttpError(401, 'A valid API token is required (Authorization: Bearer pd_…). It may have been revoked.');
}

function install(c) {
  ctx = c;
  const { route, q, now, str, need, HttpError, db } = c;
  db.exec(`CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
  )`);
  c.addColumn('api_tokens', 'expires_at', 'TEXT');
  c.addColumn('api_tokens', 'scope', "TEXT NOT NULL DEFAULT 'write'");

  route('GET', '/api/projects/:pid/api-tokens', ({ params }) => q(`SELECT t.id, t.name, t.prefix, t.created_at, t.last_used_at, t.revoked_at, t.expires_at, t.scope,
      (SELECT display_name FROM users WHERE id=t.created_by) AS created_by_name FROM api_tokens t WHERE t.project_id=? ORDER BY t.id DESC`).all(params.pid), { admin: true });

  route('POST', '/api/projects/:pid/api-tokens', ({ params, body, user }) => {
    need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
    const name = str(body.name).trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Give the token a name, for example “GitHub Actions”');
    if (q('SELECT COUNT(*) n FROM api_tokens WHERE project_id=? AND revoked_at IS NULL').get(params.pid).n >= MAX_TOKENS) throw new HttpError(400, `At most ${MAX_TOKENS} active tokens per project. Revoke some first.`);
    const scope = str(body.scope, 'write');
    if (!['read', 'write'].includes(scope)) throw new HttpError(400, 'Scope must be read or write');
    let expires = null;
    if (body.expires_in_days !== undefined && body.expires_in_days !== null && body.expires_in_days !== '') {
      const d = Number(body.expires_in_days);
      if (!Number.isInteger(d) || d < 1 || d > 3650) throw new HttpError(400, 'Expiry must be a whole number of days between 1 and 3650, or empty for no expiry');
      expires = new Date(Date.now() + d * 86400000).toISOString();
    }
    const token = `pd_${crypto.randomBytes(30).toString('base64url')}`;
    const id = Number(q('INSERT INTO api_tokens(project_id, name, token_hash, prefix, created_by, created_at, expires_at, scope) VALUES (?,?,?,?,?,?,?,?)')
      .run(params.pid, name, sha(token), token.slice(0, 8), user.id, now(), expires, scope).lastInsertRowid);
    return { id, token, prefix: token.slice(0, 8), expires_at: expires, scope };
  }, { admin: true });

  route('DELETE', '/api/api-tokens/:id', ({ params }) => {
    const t = need(q('SELECT id FROM api_tokens WHERE id=?').get(params.id), 'Token');
    q('UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(), t.id);
    return { ok: true };
  }, { admin: true });
}

module.exports = { install, authenticate };
