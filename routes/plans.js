'use strict';
// Test plans: a named group of cycles (for example a release) with rolled-up progress.

function install(ctx) {
  const { route, q, tx, now, str, need, HttpError, nextKey, CYCLE_COUNTS, sendTable } = ctx;

  const planCounts = (where) => `SELECT p.id, p.key, p.name, p.description, p.created_at,
      (SELECT COUNT(*) FROM cycles c2 WHERE c2.plan_id=p.id) AS cycles, ${CYCLE_COUNTS}
    FROM plans p LEFT JOIN cycles c ON c.plan_id=p.id LEFT JOIN executions e ON e.cycle_id=c.id WHERE ${where} GROUP BY p.id`;

  route('GET', '/api/projects/:pid/plans', ({ params }) => q(`${planCounts('p.project_id=?')} ORDER BY p.id DESC`).all(params.pid));

  route('POST', '/api/projects/:pid/plans', ({ params, body, user }) => {
    need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
    const name = str(body.name).trim();
    if (!name) throw new HttpError(400, 'Plan name is required');
    return tx(() => {
      const key = nextKey(params.pid, 'plan');
      const t = now();
      const id = Number(q('INSERT INTO plans(project_id, key, name, description, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(params.pid, key, name.slice(0, 200), str(body.description).slice(0, 5000), user.id, t).lastInsertRowid);
      return { id, key };
    });
  });

  route('GET', '/api/plans/:id', ({ params }) => {
    const plan = need(q(planCounts('p.id=?')).get(params.id), 'Plan');
    const proj = q('SELECT project_id FROM plans WHERE id=?').get(plan.id).project_id;
    plan.project_id = proj;
    plan.cycleList = q(`SELECT c.id, c.key, c.name, c.environment, c.build, c.created_at, ${CYCLE_COUNTS}
      FROM cycles c LEFT JOIN executions e ON e.cycle_id=c.id WHERE c.plan_id=? GROUP BY c.id ORDER BY c.id`).all(plan.id);
    plan.available = q('SELECT id, key, name FROM cycles WHERE project_id=? AND adhoc=0 AND plan_id IS NULL ORDER BY id DESC').all(proj);
    return plan;
  });

  route('PUT', '/api/plans/:id', ({ params, body }) => {
    need(q('SELECT 1 FROM plans WHERE id=?').get(params.id), 'Plan');
    if (body.name !== undefined && !str(body.name).trim()) throw new HttpError(400, 'Plan name is required');
    if (body.name !== undefined) q('UPDATE plans SET name=? WHERE id=?').run(str(body.name).trim().slice(0, 200), params.id);
    if (body.description !== undefined) q('UPDATE plans SET description=? WHERE id=?').run(str(body.description).slice(0, 5000), params.id);
    return { ok: true };
  });

  // Deleting a plan never deletes its cycles; they just become unplanned.
  route('DELETE', '/api/plans/:id', ({ params }) => tx(() => {
    q('UPDATE cycles SET plan_id=NULL WHERE plan_id=?').run(params.id);
    q('DELETE FROM plans WHERE id=?').run(params.id);
    return { ok: true };
  }));

  // Attach existing cycles to the plan.
  route('POST', '/api/plans/:id/cycles', ({ params, body }) => {
    const plan = need(q('SELECT id, project_id FROM plans WHERE id=?').get(params.id), 'Plan');
    const ids = [...new Set((Array.isArray(body.cycleIds) ? body.cycleIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) throw new HttpError(400, 'No cycles selected');
    return tx(() => {
      let n = 0;
      for (const id of ids) n += Number(q('UPDATE cycles SET plan_id=? WHERE id=? AND project_id=? AND adhoc=0').run(plan.id, id, plan.project_id).changes);
      return { added: n };
    });
  });

  route('GET', '/api/plans/:id/export', ({ params, query }) => {
    const plan = need(q('SELECT * FROM plans WHERE id=?').get(params.id), 'Plan');
    const rows = [['Cycle', 'Name', 'Build', 'Environment', 'Total', 'Pass', 'Fail', 'Blocked', 'Not run', 'Pass rate']];
    for (const c of q(`SELECT c.key, c.name, c.build, c.environment, ${CYCLE_COUNTS} FROM cycles c LEFT JOIN executions e ON e.cycle_id=c.id
        WHERE c.plan_id=? GROUP BY c.id ORDER BY c.id`).all(plan.id)) {
      const decided = c.pass + c.fail + c.blocked;
      rows.push([c.key, c.name, c.build, c.environment, c.total, c.pass, c.fail, c.blocked, c.not_executed + c.in_progress, decided ? `${Math.round((c.pass / decided) * 100)}%` : '']);
    }
    return sendTable(rows, str(query.get('format'), 'xlsx'), `${plan.key}-cycles`, 'Plan cycles', [16, 34, 14, 20, 8, 8, 8, 8, 8, 10]);
  });
}

module.exports = { install };
