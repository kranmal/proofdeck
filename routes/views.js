'use strict';
// Saved views: a named set of list filters (test cases, bugs, cycles) that a person can bring back in one click
// and optionally share with the rest of the project.

const SCOPES = ['cases', 'bugs', 'cycles'];

function install(ctx) {
  const { route, q, db, now, str, need, HttpError } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS saved_views (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL, name TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id, user_id, scope, name)
  )`);

  const scopeOf = (v) => { const s = str(v); if (!SCOPES.includes(s)) throw new HttpError(400, 'Unknown list'); return s; };
  // Only plain strings, numbers and booleans: a view is filter settings, never code or markup to be trusted.
  const cleanState = (st) => {
    if (!st || typeof st !== 'object' || Array.isArray(st)) throw new HttpError(400, 'Nothing to save');
    const out = {};
    for (const [k, v] of Object.entries(st).slice(0, 20)) {
      if (!/^[a-z][A-Za-z0-9_]{0,30}$/.test(k)) continue;
      if (typeof v === 'string') out[k] = v.slice(0, 300);
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
    return out;
  };

  route('GET', '/api/projects/:pid/views', ({ params, query, user }) => {
    const scope = scopeOf(query.get('scope'));
    return q(`SELECT v.id, v.name, v.shared, v.state, v.user_id, u.display_name AS owner FROM saved_views v JOIN users u ON u.id=v.user_id
      WHERE v.project_id=? AND v.scope=? AND (v.user_id=? OR v.shared=1) ORDER BY (v.user_id=?) DESC, v.name COLLATE NOCASE`).all(params.pid, scope, user.id, user.id)
      .map((v) => ({ id: v.id, name: v.name, shared: !!v.shared, mine: v.user_id === user.id, owner: v.owner, state: JSON.parse(v.state) }));
  }, { viewer: true });

  // Saving under a name you already used replaces that view.
  route('POST', '/api/projects/:pid/views', ({ params, body, user }) => {
    need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
    const scope = scopeOf(body.scope), name = str(body.name).trim();
    if (!name || name.length > 60) throw new HttpError(400, 'Give the view a name of up to 60 characters');
    if (q('SELECT COUNT(*) n FROM saved_views WHERE user_id=?').get(user.id).n >= 100) throw new HttpError(400, 'You have 100 saved views. Delete some first.');
    const shared = user.role === 'viewer' ? 0 : body.shared ? 1 : 0; // read-only accounts keep theirs private
    q(`INSERT INTO saved_views(project_id, user_id, scope, name, shared, state, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(project_id, user_id, scope, name) DO UPDATE SET shared=excluded.shared, state=excluded.state`)
      .run(params.pid, user.id, scope, name, shared, JSON.stringify(cleanState(body.state)), now());
    return { id: Number(q('SELECT id FROM saved_views WHERE project_id=? AND user_id=? AND scope=? AND name=?').get(params.pid, user.id, scope, name).id) };
  }, { viewer: true });

  route('DELETE', '/api/views/:id', ({ params, user }) => {
    const v = need(q('SELECT * FROM saved_views WHERE id=?').get(params.id), 'View');
    if (v.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'You can only delete your own views');
    q('DELETE FROM saved_views WHERE id=?').run(v.id);
    return { ok: true };
  }, { viewer: true });
}

module.exports = { install };
