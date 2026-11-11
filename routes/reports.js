'use strict';
// Reports: pass/fail trend across cycles, coverage, failure hotspots, flaky tests, bug stats, tester activity.

function install(ctx) {
  const { route, q, need, str, CYCLE_COUNTS, sendTable } = ctx;

  const clampCycles = (v) => Math.min(30, Math.max(3, Number(v) || 10));

  function trendOf(pid, n) {
    return q(`SELECT c.id, c.key, c.name, c.build, c.environment, c.created_at, ${CYCLE_COUNTS}
      FROM cycles c LEFT JOIN executions e ON e.cycle_id=c.id WHERE c.project_id=? AND c.adhoc=0
      GROUP BY c.id ORDER BY c.id DESC LIMIT ?`).all(pid, n).reverse();
  }

  // Per test case: how often it ran, failed and changed its mind between runs (pass<->fail).
  function historyOf(pid) {
    const rows = q(`SELECT e.case_id, c.key, c.title, e.status FROM executions e JOIN cases c ON c.id=e.case_id
      WHERE c.project_id=? AND e.status IN ('Pass','Fail') AND e.executed_at IS NOT NULL ORDER BY e.case_id, e.executed_at, e.id`).all(pid);
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
    const history = historyOf(pid);

    const coverage = { 'Pass': 0, 'Fail': 0, 'Blocked': 0, 'In Progress': 0, 'Never run': 0 };
    for (const r of q(`SELECT COALESCE((SELECT e.status FROM executions e WHERE e.case_id=c.id AND e.executed_at IS NOT NULL
        ORDER BY e.executed_at DESC, e.id DESC LIMIT 1), 'Never run') AS s, COUNT(*) AS n
      FROM cases c WHERE c.project_id=? AND c.status!='Deprecated' GROUP BY s`).all(pid)) coverage[r.s] = (coverage[r.s] || 0) + r.n;

    const bugRows = q('SELECT status, severity, case_key, case_id, created_at FROM bugs WHERE project_id=?').all(pid);
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

    return {
      trend: trendOf(pid, clampCycles(query.get('cycles'))),
      coverage,
      bugs: {
        total: bugRows.length,
        open: open.length,
        openBySeverity: sevOrder.map((s) => ({ severity: s, count: open.filter((b) => b.severity === s).length })),
        avgOpenAgeDays: open.length ? Math.round((open.reduce((n, b) => n + ageDays(b.created_at), 0) / open.length) * 10) / 10 : 0,
        byCase: [...byCase.values()].sort((a, b) => b.count - a.count || a.case_key.localeCompare(b.case_key)).slice(0, 10),
      },
      failing: history.filter((h) => h.fails > 0).sort((a, b) => b.fails - a.fails || b.fails / b.runs - a.fails / a.runs).slice(0, 10),
      flaky: history.filter((h) => h.flips >= 2).sort((a, b) => b.flips - a.flips || b.runs - a.runs).slice(0, 10),
      activity: q(`SELECT u.display_name AS name, COUNT(*) AS executed, SUM(e.status='Pass') AS pass, SUM(e.status='Fail') AS fail
        FROM executions e JOIN users u ON u.id=e.executed_by JOIN cycles c ON c.id=e.cycle_id
        WHERE c.project_id=? AND e.executed_at > date('now', '-30 day') GROUP BY u.id ORDER BY executed DESC, name`).all(pid),
    };
  });

  route('GET', '/api/projects/:pid/reports/export', ({ params, query }) => {
    const p = need(q('SELECT key FROM projects WHERE id=?').get(params.pid), 'Project');
    const rows = [['Cycle', 'Name', 'Build', 'Environment', 'Created', 'Total', 'Pass', 'Fail', 'Blocked', 'Not run', 'Pass rate']];
    for (const c of trendOf(params.pid, clampCycles(query.get('cycles')))) {
      const decided = c.pass + c.fail + c.blocked;
      rows.push([c.key, c.name, c.build, c.environment, c.created_at, c.total, c.pass, c.fail, c.blocked, c.not_executed + c.in_progress,
        decided ? `${Math.round((c.pass / decided) * 100)}%` : '']);
    }
    return sendTable(rows, str(query.get('format'), 'xlsx'), `${p.key}-cycle-trend`, 'Cycle trend', [16, 34, 14, 20, 24, 8, 8, 8, 8, 8, 10]);
  });
}

module.exports = { install };
