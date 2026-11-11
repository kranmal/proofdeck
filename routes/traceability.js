'use strict';
// Which requirements are covered by which test cases, and how those cases last ran.

function install(ctx) {
  const { route, q, need, str, links, sendTable } = ctx;

  const LAST = `(SELECT e.status FROM executions e WHERE e.case_id=c.id AND e.executed_at IS NOT NULL ORDER BY e.executed_at DESC, e.id DESC LIMIT 1)`;
  const OPEN_BUGS = `(SELECT COUNT(*) FROM bugs b WHERE b.case_id=c.id AND b.status IN ('Open','In Progress'))`;

  function statusOf(cases) {
    const s = cases.map((c) => c.last_status || 'Never run');
    if (s.includes('Fail')) return 'Failing';
    if (s.includes('Blocked')) return 'Blocked';
    if (s.every((x) => x === 'Pass')) return 'Passing';
    if (s.some((x) => x === 'Pass' || x === 'In Progress')) return 'Partly run';
    return 'Not run';
  }

  function build(pid) {
    const rows = q(`SELECT l.ref, l.title, l.url, c.id, c.key, c.title AS case_title, ${LAST} AS last_status, ${OPEN_BUGS} AS open_bugs
      FROM case_links l JOIN cases c ON c.id=l.case_id WHERE c.project_id=? AND c.status!='Deprecated' ORDER BY l.ref COLLATE NOCASE, c.id`).all(pid);
    const byRef = new Map();
    for (const r of rows) {
      const k = r.ref.toLowerCase();
      let e = byRef.get(k);
      if (!e) byRef.set(k, e = { ref: r.ref, title: '', url: '', cases: [] });
      if (!e.title && r.title) e.title = r.title;
      if (!e.url) e.url = links.hrefFor(pid, r);
      e.cases.push({ id: r.id, key: r.key, title: r.case_title, last_status: r.last_status || 'Never run', open_bugs: r.open_bugs });
    }
    const requirements = [...byRef.values()].map((e) => ({ ...e, status: statusOf(e.cases) }));
    const uncovered = q(`SELECT c.id, c.key, c.title FROM cases c WHERE c.project_id=? AND c.status!='Deprecated'
      AND NOT EXISTS (SELECT 1 FROM case_links l WHERE l.case_id=c.id) ORDER BY c.id`).all(pid);
    const count = (st) => requirements.filter((r) => r.status === st).length;
    return {
      requirements, uncovered,
      summary: { requirements: requirements.length, passing: count('Passing'), failing: count('Failing'), blocked: count('Blocked'), partly: count('Partly run'), notRun: count('Not run'), uncovered: uncovered.length },
    };
  }

  route('GET', '/api/projects/:pid/traceability', ({ params }) => {
    need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
    return build(params.pid);
  });

  route('GET', '/api/projects/:pid/traceability/export', ({ params, query }) => {
    const p = need(q('SELECT key FROM projects WHERE id=?').get(params.pid), 'Project');
    const t = build(params.pid);
    const rows = [['Requirement', 'Title', 'Coverage', 'Test case', 'Test case title', 'Last result', 'Open bugs']];
    for (const r of t.requirements) for (const c of r.cases) rows.push([r.ref, r.title, r.status, c.key, c.title, c.last_status, c.open_bugs]);
    for (const c of t.uncovered) rows.push(['(no requirement)', '', 'Uncovered', c.key, c.title, '', '']);
    return sendTable(rows, str(query.get('format'), 'xlsx'), `${p.key}-traceability`, 'Traceability', [18, 34, 14, 14, 40, 14, 10]);
  });
}

module.exports = { install };
