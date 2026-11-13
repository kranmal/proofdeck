'use strict';
// Case templates: a saved starting point (objective, precondition, priority, labels, steps, data sets, script,
// custom field values) for new test cases. Steps that call other test cases are left out, so a template never
// depends on a case that may later be deleted.

function install(ctx) {
  const { route, q, db, now, str, need, HttpError, fieldsApi } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS case_templates (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, name)
  )`);

  route('GET', '/api/projects/:pid/templates', ({ params }) => q(`SELECT t.id, t.name, t.created_at, t.created_by, (SELECT display_name FROM users WHERE id=t.created_by) AS created_by_name, t.data
    FROM case_templates t WHERE t.project_id=? ORDER BY t.name COLLATE NOCASE`).all(params.pid)
    .map(({ data, ...t }) => ({ ...t, steps: JSON.parse(data).steps.length })));

  route('GET', '/api/templates/:id', ({ params }) => {
    const t = need(q('SELECT * FROM case_templates WHERE id=?').get(params.id), 'Template');
    return { id: t.id, name: t.name, data: JSON.parse(t.data) };
  });

  // Saving under an existing name replaces that template.
  route('POST', '/api/projects/:pid/templates', ({ params, body, user }) => {
    need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
    const name = str(body.name).trim();
    if (!name || name.length > 80) throw new HttpError(400, 'Give the template a name of up to 80 characters');
    const c = need(q('SELECT * FROM cases WHERE id=? AND project_id=?').get(body.caseId, params.pid), 'Test case');
    if (q('SELECT COUNT(*) n FROM case_templates WHERE project_id=?').get(params.pid).n >= 100) throw new HttpError(400, 'A project can have up to 100 templates');
    const data = {
      objective: c.objective, precondition: c.precondition, priority: c.priority, labels: c.labels, script_type: c.script_type || 'steps', bdd_script: c.bdd_script || '',
      params: (() => { try { const p = JSON.parse(c.params); if (Array.isArray(p.columns) && Array.isArray(p.rows)) return p; } catch { /* none */ } return { columns: [], rows: [] }; })(),
      steps: q('SELECT action, test_data, expected FROM steps WHERE case_id=? AND call_case_id IS NULL ORDER BY position').all(c.id),
      fields: fieldsApi.read('case', c.id),
    };
    q(`INSERT INTO case_templates(project_id, name, created_by, created_at, data) VALUES (?,?,?,?,?)
       ON CONFLICT(project_id, name) DO UPDATE SET data=excluded.data, created_by=excluded.created_by, created_at=excluded.created_at`).run(params.pid, name, user.id, now(), JSON.stringify(data));
    return { id: Number(q('SELECT id FROM case_templates WHERE project_id=? AND name=?').get(params.pid, name).id) };
  });

  route('DELETE', '/api/templates/:id', ({ params, user }) => {
    const t = need(q('SELECT * FROM case_templates WHERE id=?').get(params.id), 'Template');
    if (t.created_by !== user.id && user.role !== 'admin') throw new HttpError(403, 'You can only delete your own templates');
    q('DELETE FROM case_templates WHERE id=?').run(t.id);
    return { ok: true };
  });
}

module.exports = { install };
