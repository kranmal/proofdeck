'use strict';
// Reports: pass/fail trend across cycles, coverage, failure hotspots, flaky tests, bug stats, tester activity.
// Every section honours the same filters: from / to (dates), folder (with subfolders), label, plan_id.

function install(ctx) {
  const { route, q, need, str, HttpError, CYCLE_COUNTS, sendTable, normFolder } = ctx;

  const clampCycles = (v) => Math.min(30, Math.max(3, Number(v) || 10));
  const date = (v, label) => {
    const s = str(v).trim();
    if (!s) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `“${label}” must be a date (YYYY-MM-DD)`);
    return s;
  };
  const marks = (n) => Array(n).fill('?').join(',');

  // Turns the query string into: a date window, a plan, and (when folder/label are given) the set of case ids that qualify.
  function filtersOf(pid, query) {
    const from = date(query.get('from'), 'From'), to = date(query.get('to'), 'To');
    if (from && to && from > to) throw new HttpError(400, '“From” must not be after “To”');
    const folder = normFolder(query.get('folder') || '');
    const label = str(query.get('label')).trim().toLowerCase();
    const planId = Number(query.get('plan_id')) || 0;
    let caseIds = null;
    if (folder || label) {
      caseIds = q('SELECT id, folder, labels FROM cases WHERE project_id=?').all(pid)
        .filter((c) => (!folder || c.folder === folder || c.folder.startsWith(`${folder}/`)) && (!label || c.labels.toLowerCase().split(',').map((x) => x.trim()).includes(label)))
        .map((c) => c.id);
    }
    return { from, to, folder, label, planId, caseIds, active: !!(from || to || folder || label || planId) };
  }
  const inCases = (f, col) => (f.caseIds ? (f.caseIds.length ? `AND ${col} IN (${marks(f.caseIds.length)})` : 'AND 0') : '');
  const caseArgs = (f) => (f.caseIds || []);
  const window = (f, col) => [f.from ? `AND date(${col}) >= ?` : '', f.to ? `AND date(${col}) <= ?` : ''].join(' ');
  const windowArgs = (f) => [f.from, f.to].filter(Boolean);

  function trendOf(pid, n, f) {
    const filtered = f.caseIds ? `AND ${f.caseIds.length ? `e.case_id IN (${marks(f.caseIds.length)})` : '0'}` : '';
    return q(`SELECT c.id, c.key, c.name, c.build, c.environment, c.created_at, ${CYCLE_COUNTS}
      FROM cycles c LEFT JOIN executions e ON e.cycle_id=c.id ${filtered}
      WHERE c.project_id=? AND c.adhoc=0 ${f.planId ? 'AND c.plan_id=?' : ''} ${window(f, 'c.created_at')}
      GROUP BY c.id ORDER BY c.id DESC LIMIT ?`).all(...caseArgs(f), pid, ...(f.planId ? [f.planId] : []), ...windowArgs(f), n).reverse();
  }

  // Per test case: how often it ran, failed and changed its mind between runs (pass<->fail).
  function historyOf(pid, f) {
    const rows = q(`SELECT e.case_id, c.key, c.title, e.status FROM executions e JOIN cases c ON c.id=e.case_id JOIN cycles cy ON cy.id=e.cycle_id
      WHERE c.project_id=? AND e.status IN ('Pass','Fail') AND e.executed_at IS NOT NULL ${f.planId ? 'AND cy.plan_id=?' : ''} ${window(f, 'e.executed_at')} ${inCases(f, 'e.case_id')}
      ORDER BY e.case_id, e.executed_at, e.id`).all(pid, ...(f.planId ? [f.planId] : []), ...windowArgs(f), ...caseArgs(f));
    const by = new Map();
    for (const r of rows) {
      let h = by.get(r.case_id);
      if (!h) by.set(r.case_id, h = { case_id: r.case_id, key: r.key, title: r.title, runs: 0, fails: 0, flips: 0, last: '' });
      if (h.last && h.last !== r.status) h.flips++;
      h.runs++;
      if (r.status === 'Fail') h.fails++;
      h.last = r.status;
    }
    return [...by.values()];
  }

  route('GET', '/api/projects/:pid/reports', ({ params, query }) => {
    const pid = params.pid;
    need(q('SELECT 1 FROM projects WHERE id=?').get(pid), 'Project');
    const f = filtersOf(pid, query);
    const history = historyOf(pid, f);

    const coverage = { 'Pass': 0, 'Fail': 0, 'Blocked': 0, 'In Progress': 0, 'Never run': 0 };
    for (const r of q(`SELECT COALESCE((SELECT e.status FROM executions e WHERE e.case_id=c.id AND e.executed_at IS NOT NULL ${window(f, 'e.executed_at')}
        ORDER BY e.executed_at DESC, e.id DESC LIMIT 1), 'Never run') AS s, COUNT(*) AS n
      FROM cases c WHERE c.project_id=? AND c.status!='Deprecated' ${inCases(f, 'c.id')} GROUP BY s`).all(...windowArgs(f), pid, ...caseArgs(f))) coverage[r.s] = (coverage[r.s] || 0) + r.n;

    const bugRows = q(`SELECT status, severity, case_key, case_id, created_at FROM bugs b WHERE project_id=? ${window(f, 'b.created_at')} ${inCases(f, 'b.case_id')}`).all(pid, ...windowArgs(f), ...caseArgs(f));
    const open = bugRows.filter((b) => b.status === 'Open' || b.status === 'In Progress');
    const sevOrder = ['Critical', 'Major', 'Minor', 'Trivial'];
    const byCase = new Map();
    for (const b of bugRows) {
      if (!b.case_key) continue;
      const e = byCase.get(b.case_key) || { case_key: b.case_key, case_id: b.case_id, count: 0, open: 0 };
      e.count++;
      if (b.status === 'Open' || b.status === 'In Progress') e.open++;
      byCase.set(b.case_key, e);
    }
    const ageDays = (iso) => Math.max(0, (Date.now() - Date.parse(iso)) / 86400000);
    const actFrom = f.from || null;

    const slowest = q(`SELECT e.case_id, c.key, c.title, COUNT(*) AS runs, CAST(AVG(e.duration_ms) AS INTEGER) AS avg_ms, MAX(e.duration_ms) AS max_ms
      FROM executions e JOIN cases c ON c.id=e.case_id JOIN cycles cy ON cy.id=e.cycle_id
      WHERE c.project_id=? AND e.duration_ms > 0 ${f.planId ? 'AND cy.plan_id=?' : ''} ${window(f, 'e.executed_at')} ${inCases(f, 'e.case_id')}
      GROUP BY e.case_id ORDER BY avg_ms DESC, c.id LIMIT 10`).all(pid, ...(f.planId ? [f.planId] : []), ...windowArgs(f), ...caseArgs(f));
    return {
      filters: { from: f.from, to: f.to, folder: f.folder, label: f.label, plan_id: f.planId || null, active: f.active },
      trend: trendOf(pid, clampCycles(query.get('cycles')), f),
      coverage,
      bugs: {
        total: bugRows.length,
        open: open.length,
        openBySeverity: sevOrder.map((s) => ({ severity: s, count: open.filter((b) => b.severity === s).length })),
        avgOpenAgeDays: open.length ? Math.round((open.reduce((n, b) => n + ageDays(b.created_at), 0) / open.length) * 10) / 10 : 0,
        byCase: [...byCase.values()].sort((a, b) => b.count - a.count || a.case_key.localeCompare(b.case_key)).slice(0, 10),
      },
      slowest,
      failing: history.filter((h) => h.fails > 0).sort((a, b) => b.fails - a.fails || b.fails / b.runs - a.fails / a.runs).slice(0, 10),
      flaky: history.filter((h) => h.flips >= 2).sort((a, b) => b.flips - a.flips || b.runs - a.runs).slice(0, 10),
      // With no dates given, tester activity looks at the last 30 days; with dates it follows the window.
      activity: q(`SELECT u.display_name AS name, COUNT(*) AS executed, SUM(e.status='Pass') AS pass, SUM(e.status='Fail') AS fail
        FROM executions e JOIN users u ON u.id=e.executed_by JOIN cycles c ON c.id=e.cycle_id
        WHERE c.project_id=? ${actFrom || f.to ? window(f, 'e.executed_at') : "AND e.executed_at > date('now', '-30 day')"} ${f.planId ? 'AND c.plan_id=?' : ''} ${inCases(f, 'e.case_id')}
        GROUP BY u.id ORDER BY executed DESC, name`).all(pid, ...(actFrom || f.to ? windowArgs(f) : []), ...(f.planId ? [f.planId] : []), ...caseArgs(f)),
    };
  });

  route('GET', '/api/projects/:pid/reports/export', ({ params, query }) => {
    const p = need(q('SELECT key FROM projects WHERE id=?').get(params.pid), 'Project');
    const rows = [['Cycle', 'Name', 'Build', 'Environment', 'Created', 'Total', 'Pass', 'Fail', 'Blocked', 'Not run', 'Pass rate']];
    for (const c of trendOf(params.pid, clampCycles(query.get('cycles')), filtersOf(params.pid, query))) {
      const decided = c.pass + c.fail + c.blocked;
      rows.push([c.key, c.name, c.build, c.environment, c.created_at, c.total, c.pass, c.fail, c.blocked, c.not_executed + c.in_progress,
        decided ? `${Math.round((c.pass / decided) * 100)}%` : '']);
    }
    return sendTable(rows, str(query.get('format'), 'xlsx'), `${p.key}-cycle-trend`, 'Cycle trend', [16, 34, 14, 20, 24, 8, 8, 8, 8, 8, 10]);
  });
}

module.exports = { install };
