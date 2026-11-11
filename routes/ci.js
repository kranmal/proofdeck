'use strict';
// CI results: record automated test results into a cycle through an API token.
//   POST /api/ci/results   JSON results (find-or-create the cycle, match cases by key or automation key)
//   POST /api/ci/junit     a JUnit XML report as the request body
//   GET  /api/ci/cycle     counts and a pass/fail verdict, for pipeline gates
// Every item is applied inside a savepoint, so one bad result never leaves half a change behind.

const { parseJunit, JunitError } = require('../lib/junit');

const MAX_RESULTS = 5000;
const MAX_ATTACHMENTS = 5;
const ALIASES = {
  pass: 'Pass', passed: 'Pass', success: 'Pass', ok: 'Pass',
  fail: 'Fail', failed: 'Fail', failure: 'Fail', error: 'Fail',
  blocked: 'Blocked',
  skip: 'Skipped', skipped: 'Skipped', ignored: 'Skipped', pending: 'Skipped', 'not executed': 'Skipped',
};

function install(ctx) {
  const { route, q, tx, db, now, str, HttpError, nextKey, CYCLE_COUNTS, snapshotCase, rollup, insertCase, saveAttachment, autoKeyTaken, planOrNull, normFolder } = ctx;

  const norm = (v) => ALIASES[str(v).trim().toLowerCase()] || null;
  const bool = (v) => v === true || ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
  const base = () => (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  const firstLine = (t) => str(t).split(/\r?\n/).find((l) => l.trim())?.trim() || '';

  function resolveCycle(token, spec) {
    const pid = token.project_id;
    if (!spec || typeof spec !== 'object') throw new HttpError(400, 'Say which cycle: {"id": 7} or {"name": "Nightly", "build": "1.2.3"}');
    if (spec.id !== undefined && spec.id !== null && spec.id !== '') {
      const c = q('SELECT * FROM cycles WHERE id=? AND project_id=? AND adhoc=0').get(Number(spec.id), pid);
      if (!c) throw new HttpError(404, 'That cycle does not exist in this token’s project');
      return { cycle: c, created: false };
    }
    const name = str(spec.name).trim().slice(0, 200);
    if (!name) throw new HttpError(400, 'Say which cycle: {"id": 7} or {"name": "Nightly", "build": "1.2.3"}');
    const build = str(spec.build).trim().slice(0, 200);
    const found = q('SELECT * FROM cycles WHERE project_id=? AND adhoc=0 AND name=? COLLATE NOCASE AND build=? COLLATE NOCASE ORDER BY id DESC').get(pid, name, build);
    if (found) return { cycle: found, created: false };
    const key = nextKey(pid, 'cycle');
    const id = Number(q('INSERT INTO cycles(project_id, key, name, description, environment, build, created_at, created_by, plan_id) VALUES (?,?,?,?,?,?,?,NULL,?)')
      .run(pid, key, name, str(spec.description).slice(0, 5000) || `Created through the API token “${token.name}”.`, str(spec.environment).trim().slice(0, 200), build, now(), planOrNull(pid, spec.plan_id)).lastInsertRowid);
    return { cycle: q('SELECT * FROM cycles WHERE id=?').get(id), created: true };
  }

  function resolveCase(token, r, opts) {
    const pid = token.project_id;
    const ref = r.case;
    const ak = str(r.automation_key).trim().slice(0, 300);
    if (ref !== undefined && ref !== null && ref !== '') {
      const c = /^\d+$/.test(String(ref)) ? q('SELECT * FROM cases WHERE id=? AND project_id=?').get(Number(ref), pid)
        : q('SELECT * FROM cases WHERE project_id=? AND key=? COLLATE NOCASE').get(pid, String(ref).trim());
      if (!c) throw new Error(`No test case “${ref}” in this project`);
      // Sending both once binds the automation key to the case for next time.
      if (ak && !c.automation_key && !autoKeyTaken(pid, ak, c.id)) q('UPDATE cases SET automation_key=? WHERE id=?').run(ak, c.id);
      return { c: q('SELECT * FROM cases WHERE id=?').get(c.id), created: false };
    }
    if (!ak) throw new Error('Each result needs "case" (a key such as DEMO-T3) or "automation_key"');
    const hit = q('SELECT * FROM cases WHERE project_id=? AND automation_key=?').get(pid, ak);
    if (hit) return { c: hit, created: false };
    if (!opts.autoCreate) throw new Error(`No test case has the automation key “${ak}”. Set it on the test case, send "case" together with it once, or turn on autoCreate.`);
    const made = insertCase(pid, { title: str(r.title).trim().slice(0, 200) || ak.slice(0, 200), status: 'Draft', labels: 'automated', folder: normFolder(r.folder || opts.folder || 'Automated'), automation_key: ak }, null);
    return { c: q('SELECT * FROM cases WHERE id=?').get(made.id), created: true };
  }

  function openBug({ pid, cycle, c, exec, step, message, label, attachmentIds }) {
    const existing = q("SELECT id, key FROM bugs WHERE project_id=? AND case_id=? AND status IN ('Open','In Progress') ORDER BY id DESC").get(pid, c.id);
    const msg = str(message).trim() || 'Automated test failed';
    if (existing) {
      q('INSERT INTO bug_comments(bug_id, user_id, body, created_at) VALUES (?,NULL,?,?)').run(existing.id, `Failed again in ${cycle.key} (${label}): ${msg.slice(0, 2000)}`, now());
      return { key: existing.key, existing: true };
    }
    const key = nextKey(pid, 'bug');
    const t = now();
    const id = Number(q(`INSERT INTO bugs(project_id, key, title, severity, priority, environment, expected, actual, steps_to_reproduce,
        case_id, execution_id, step_result_id, case_key, cycle_key, step_no, created_at, updated_at, reported_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(pid, key, `[CI] ${c.key}: ${firstLine(msg) || 'test failed'}`.slice(0, 300), 'Major', 'Medium',
      [cycle.environment, cycle.build && `Build ${cycle.build}`].filter(Boolean).join(' · '), step ? step.expected : c.objective, msg.slice(0, 20000),
      `Automated test${c.automation_key ? ` ${c.automation_key}` : ''}, reported by ${label} in ${cycle.key}.`,
      c.id, exec.id, step ? step.id : null, c.key, cycle.key, step ? step.position : null, t, t).lastInsertRowid);
    const copy = q(`INSERT INTO attachments(owner_type, owner_id, filename, mime, size, data, created_at)
      SELECT 'bug', ?, filename, mime, size, data, ? FROM attachments WHERE id=?`);
    for (const aid of attachmentIds) copy.run(id, t, aid);
    return { key, existing: false };
  }

  function applyResult(token, cycle, r, opts, label) {
    const given = r.status !== undefined && r.status !== null && r.status !== '';
    const status = given ? norm(r.status) : null;
    if (given && !status) throw new Error(`Unknown status “${r.status}”. Use Pass, Fail, Blocked or Skipped.`);
    const stepsGiven = Array.isArray(r.steps) && r.steps.length > 0;
    if (!status && !stepsGiven) throw new Error('Give a "status" (Pass, Fail, Blocked) or per-step "steps"');
    // A skipped test changes nothing, so it is fine if Proofdeck does not know it, and it never creates a case.
    if (status === 'Skipped' && !stepsGiven) {
      let known = null;
      try { known = resolveCase(token, r, { ...opts, autoCreate: false }).c; } catch { /* unknown is fine */ }
      return { case: known ? known.key : str(r.case || r.automation_key), ...(r.automation_key ? { automation_key: str(r.automation_key) } : {}), status: 'Skipped', skipped: true, warnings: [] };
    }
    const { c, created } = resolveCase(token, r, opts);
    if (c.status === 'Deprecated') throw new Error(`${c.key} is deprecated`);
    const out = { case: c.key, ...(c.automation_key ? { automation_key: c.automation_key } : {}), ...(created ? { created_case: true } : {}), warnings: [] };

    let execs = q('SELECT id, iteration FROM executions WHERE cycle_id=? AND case_id=? ORDER BY id').all(cycle.id, c.id);
    if (!execs.length) { snapshotCase(cycle.id, c); execs = q('SELECT id, iteration FROM executions WHERE cycle_id=? AND case_id=? ORDER BY id').all(cycle.id, c.id); }
    if (r.iteration !== undefined && r.iteration !== null) {
      execs = execs.filter((e) => e.iteration === Number(r.iteration));
      if (!execs.length) throw new Error(`${c.key} has no data set ${r.iteration} in this cycle`);
    }

    const comment = [r.message && `[CI] ${str(r.message).slice(0, 4000)}`, Number(r.duration_ms) > 0 ? `(${(Number(r.duration_ms) / 1000).toFixed(1)} s)` : ''].filter(Boolean).join(' ');
    for (const e of execs) {
      const srs = q('SELECT id, position FROM step_results WHERE execution_id=? ORDER BY position').all(e.id);
      if (stepsGiven) {
        for (const s of r.steps) {
          const sr = srs.find((x) => x.position === Number(s && s.position));
          if (!sr) throw new Error(`${c.key} has no step ${s && s.position}`);
          const st = s.status === undefined ? null : norm(s.status);
          if (s.status !== undefined && !st) throw new Error(`Unknown status “${s.status}” for step ${s.position}`);
          if (st && st !== 'Skipped') q('UPDATE step_results SET status=? WHERE id=?').run(st, sr.id);
          if (s.actual !== undefined) q('UPDATE step_results SET actual=? WHERE id=?').run(str(s.actual).slice(0, 20000), sr.id);
        }
        rollup(e.id, null);
      } else if (status === 'Pass' && srs.length) {
        q("UPDATE step_results SET status='Pass' WHERE execution_id=?").run(e.id);
        rollup(e.id, null);
      }
      if (status && status !== 'Skipped') q('UPDATE executions SET status=?, executed_at=? WHERE id=?').run(status, now(), e.id); // an explicit status wins
      q("UPDATE executions SET executed_by=NULL, executed_by_label=?, comment=CASE WHEN ?!='' THEN ? ELSE comment END WHERE id=?").run(label, comment, comment, e.id);
      const ms = Number(r.duration_ms);
      if (Number.isFinite(ms) && ms >= 0) q('UPDATE executions SET duration_ms=? WHERE id=?').run(Math.min(Math.round(ms), 7 * 86400000), e.id);
    }
    const finals = execs.map((e) => q('SELECT id, status FROM executions WHERE id=?').get(e.id));
    out.execution_ids = finals.map((f) => f.id);
    out.status = finals[0].status;
    if (!status && finals.every((f) => f.status === 'Not Executed')) out.warnings.push('No step had a status, so nothing was recorded.');

    // Files (logs, screenshots) go on the failing step, or the first one; at most five per result.
    const attachmentIds = [];
    let target = null;
    const e0 = execs[0];
    const srs0 = q('SELECT id, position, status, expected FROM step_results WHERE execution_id=? ORDER BY position').all(e0.id);
    target = (r.attach_step && srs0.find((x) => x.position === Number(r.attach_step))) || srs0.find((x) => x.status === 'Fail') || srs0[0] || null;
    if (Array.isArray(r.attachments) && r.attachments.length) {
      if (!target) out.warnings.push('This test case has no steps, so the files were not attached.');
      else for (const att of r.attachments.slice(0, MAX_ATTACHMENTS)) {
        try { attachmentIds.push(saveAttachment('step', target.id, att).id); } catch (e) { out.warnings.push(`File ${str(att && att.filename) || '?'} was not attached: ${e.message}`); }
      }
      if (r.attachments.length > MAX_ATTACHMENTS) out.warnings.push(`Only the first ${MAX_ATTACHMENTS} files were attached.`);
    }

    const wantBug = r.bug !== undefined ? bool(r.bug) : opts.createBugs;
    if (wantBug && finals.some((f) => f.status === 'Fail')) {
      out.bug = openBug({ pid: token.project_id, cycle, c, exec: e0, step: srs0.find((x) => x.status === 'Fail') || target, message: r.message, label, attachmentIds });
    }
    return out;
  }

  function ingest(token, cycleSpec, results, opts) {
    if (!Array.isArray(results) || !results.length) throw new HttpError(400, '"results" must be a non-empty list');
    if (results.length > MAX_RESULTS) throw new HttpError(400, `At most ${MAX_RESULTS} results per request. Send them in batches.`);
    return tx(() => {
      const { cycle, created } = resolveCycle(token, cycleSpec);
      const label = `API: ${token.name}`.slice(0, 80);
      const list = [];
      const sum = { received: results.length, recorded: 0, skipped: 0, errors: 0, created_cases: 0, bugs_created: 0, bugs_updated: 0 };
      results.forEach((r, index) => {
        db.exec('SAVEPOINT ci_item');
        try {
          if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Each result must be an object');
          const res = applyResult(token, cycle, r, opts, label);
          db.exec('RELEASE ci_item');
          list.push(res);
          if (res.skipped) sum.skipped++; else sum.recorded++;
          if (res.created_case) sum.created_cases++;
          if (res.bug) { if (res.bug.existing) sum.bugs_updated++; else sum.bugs_created++; }
        } catch (e) {
          db.exec('ROLLBACK TO ci_item'); db.exec('RELEASE ci_item');
          sum.errors++;
          list.push({ index, case: str(r && (r.case || r.automation_key)) || `#${index + 1}`, error: e.message });
        }
      });
      if (opts.strict && sum.errors) throw new HttpError(422, `Nothing was saved: ${sum.errors} of ${results.length} results have problems.`, { results: list });
      const n = q(`SELECT ${CYCLE_COUNTS} FROM executions e WHERE e.cycle_id=?`).get(cycle.id);
      return {
        ok: sum.errors === 0,
        cycle: { id: cycle.id, key: cycle.key, name: cycle.name, build: cycle.build, created, url: `${base()}/#/cycles/${cycle.id}` },
        counts: { total: n.total, pass: n.pass, fail: n.fail, blocked: n.blocked, not_run: n.not_executed + n.in_progress },
        summary: sum, results: list,
      };
    });
  }

  const optsOf = (get) => ({ autoCreate: bool(get('autoCreate')), createBugs: bool(get('createBugs')), strict: bool(get('strict')), folder: get('folder') });

  route('POST', '/api/ci/results', ({ body, token }) => ingest(token, body.cycle, body.results, optsOf((k) => body[k])), { token: true });

  route('POST', '/api/ci/junit', ({ body, query, token }) => {
    let tests;
    try { tests = parseJunit(body, { keyMode: query.get('key') === 'name' ? 'name' : 'classname' }); }
    catch (e) { if (e instanceof JunitError) throw new HttpError(400, e.message); throw e; }
    const skipped = query.get('skipped') === 'blocked' ? 'Blocked' : 'Skipped';
    const results = tests.map((t) => ({
      automation_key: t.automation_key, title: t.title, status: t.status === 'Skipped' ? skipped : t.status, message: t.message, duration_ms: t.duration_ms,
      ...(t.output ? { attachments: [{ filename: 'output.log', mime: 'text/plain', data: Buffer.from(t.output).toString('base64') }] } : {}),
    }));
    const spec = query.get('cycle_id') ? { id: query.get('cycle_id') }
      : { name: query.get('cycle'), build: query.get('build'), environment: query.get('environment'), plan_id: query.get('plan_id') || undefined };
    return ingest(token, spec, results, optsOf((k) => query.get(k)));
  }, { token: true, raw: true });

  route('GET', '/api/ci/cycle', ({ query, token }) => {
    const c = query.get('id')
      ? q('SELECT * FROM cycles WHERE id=? AND project_id=? AND adhoc=0').get(Number(query.get('id')), token.project_id)
      : q('SELECT * FROM cycles WHERE project_id=? AND adhoc=0 AND name=? COLLATE NOCASE AND build=? COLLATE NOCASE ORDER BY id DESC').get(token.project_id, str(query.get('name')), str(query.get('build')));
    if (!c) throw new HttpError(404, 'Cycle not found. Pass ?id=… or ?name=…&build=…');
    const n = q(`SELECT ${CYCLE_COUNTS} FROM executions e WHERE e.cycle_id=?`).get(c.id);
    const left = n.not_executed + n.in_progress;
    const status = n.fail ? 'failing' : n.blocked ? 'blocked' : !n.total || left ? 'incomplete' : 'passing';
    return { id: c.id, key: c.key, name: c.name, build: c.build, status, ok: status === 'passing',
      counts: { total: n.total, pass: n.pass, fail: n.fail, blocked: n.blocked, not_run: left }, url: `${base()}/#/cycles/${c.id}` };
  }, { token: true });
}

module.exports = { install };
