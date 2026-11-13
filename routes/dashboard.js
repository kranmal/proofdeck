'use strict';
// Your own dashboard (what is waiting for you, what you did lately, how the team is doing) and the weekly email
// that says the same thing on Monday morning.

function install(ctx) {
  const { route, q, str, notifier, HttpError } = ctx;
  const OPEN = "('Not Executed','In Progress')";

  // Everything the dashboard and the email need for one person in one project. `today` is that person's own date.
  function personal(userId, pid, today) {
    const runs = q(`SELECT e.id, e.case_key, e.case_title, e.status, c.id AS cycle_id, c.key AS cycle_key, c.name AS cycle_name, c.due_date
      FROM executions e JOIN cycles c ON c.id=e.cycle_id WHERE c.project_id=? AND c.adhoc=0 AND e.assignee_id=? AND e.status IN ${OPEN}
      ORDER BY (c.due_date='') , c.due_date, e.id`).all(pid, userId).map((r) => ({ ...r, overdue: !!r.due_date && r.due_date < today }));
    const bugs = q("SELECT id, key, title, severity, status FROM bugs WHERE project_id=? AND assignee_id=? AND status IN ('Open','In Progress') ORDER BY CASE severity WHEN 'Critical' THEN 0 WHEN 'Major' THEN 1 WHEN 'Minor' THEN 2 ELSE 3 END, id DESC").all(pid, userId);
    const reviews = q("SELECT id, key, title FROM cases WHERE project_id=? AND status='In Review' AND reviewer_id=? ORDER BY updated_at").all(pid, userId);
    const since = (days) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
    const tally = (where, args, days) => q(`SELECT substr(e.executed_at,1,10) AS day, COALESCE(SUM(e.status='Pass'),0) AS pass, COALESCE(SUM(e.status='Fail'),0) AS fail, COALESCE(SUM(e.status='Blocked'),0) AS blocked
      FROM executions e JOIN cycles c ON c.id=e.cycle_id WHERE c.project_id=? AND e.executed_at>=? AND e.status IN ('Pass','Fail','Blocked') ${where} GROUP BY day ORDER BY day`).all(pid, `${since(days)}`, ...args);
    const week = (rows, from, to) => { const r = rows.filter((x) => x.day >= from && x.day < to); const p = r.reduce((a, x) => a + x.pass, 0), f = r.reduce((a, x) => a + x.fail, 0), b = r.reduce((a, x) => a + x.blocked, 0); return { pass: p, fail: f, blocked: b, total: p + f + b }; };
    const mineDays = tally('AND e.executed_by=?', [userId], 14);
    const teamRows = tally('', [], 56);
    // eight 7-day windows ending today; the last one is "the last 7 days"
    const weeks = Array.from({ length: 8 }, (_, i) => { const from = since(6 + 7 * (7 - i)), to = i === 7 ? '9999' : since(6 + 7 * (6 - i)); return { from, ...week(teamRows, from, to) }; });
    return {
      today, runs, bugs, reviews,
      overdueRuns: runs.filter((r) => r.overdue).length,
      done14: mineDays, doneLastWeek: week(mineDays, since(6), '9999'),
      teamWeekly: weeks, teamLastWeek: weeks[7],
    };
  }
  ctx.dashboard = { personal };

  route('GET', '/api/projects/:pid/dashboard', ({ params, user }) => personal(user.id, params.pid, ctx.localNow(user.timezone).day), { viewer: true });

  // ----- weekly email -----
  const rate = (w) => (w.pass + w.fail + w.blocked ? `${Math.round((w.pass / (w.pass + w.fail + w.blocked)) * 100)}%` : 'no results');
  function weeklyText(user) {
    const today = ctx.localNow(user.timezone).day, base = notifier.publicUrl();
    const L = (path) => (base ? `${base}/${path}` : '');
    const parts = [];
    for (const p of q('SELECT id, key, name FROM projects ORDER BY id').all()) {
      const d = personal(user.id, p.id, today);
      if (!d.runs.length && !d.bugs.length && !d.reviews.length && !d.doneLastWeek.total && !d.teamLastWeek.total) continue;
      const lines = [`${p.name} (${p.key})`, ''];
      lines.push(`Waiting for you: ${d.runs.length} test run${d.runs.length === 1 ? '' : 's'}${d.overdueRuns ? ` (${d.overdueRuns} overdue)` : ''}, ${d.bugs.length} open bug${d.bugs.length === 1 ? '' : 's'}, ${d.reviews.length} test case${d.reviews.length === 1 ? '' : 's'} to review.`);
      for (const r of d.runs.slice(0, 8)) lines.push(`  - ${r.case_key} ${r.case_title} in ${r.cycle_key}${r.due_date ? `, due ${r.due_date}${r.overdue ? ' (overdue)' : ''}` : ''}${L(`#/run/${r.id}`) ? `\n    ${L(`#/run/${r.id}`)}` : ''}`);
      if (d.runs.length > 8) lines.push(`  …and ${d.runs.length - 8} more`);
      for (const b of d.bugs.slice(0, 5)) lines.push(`  - ${b.key} ${b.title} (${b.severity})${L(`#/bugs/${b.id}`) ? `\n    ${L(`#/bugs/${b.id}`)}` : ''}`);
      lines.push('', `You ran ${d.doneLastWeek.total} test${d.doneLastWeek.total === 1 ? '' : 's'} in the last 7 days (${d.doneLastWeek.pass} passed, ${d.doneLastWeek.fail} failed, ${d.doneLastWeek.blocked} blocked).`);
      lines.push(`The team ran ${d.teamLastWeek.total}, pass rate ${rate(d.teamLastWeek)}.`);
      parts.push(lines.join('\n'));
    }
    if (!parts.length) return null;
    return [`Hello ${user.display_name}, here is your week in Proofdeck.`, '', ...parts.flatMap((x) => [x, '']), '--', 'You get this on Mondays. Turn it off from your account menu.'].join('\n');
  }
  ctx.weeklyText = weeklyText;

  // Mondays, after the chosen hour on the person's own clock, about once a week.
  const WEEK_MS = process.env.NOTIFY_WEEKLY_MS !== undefined ? Number(process.env.NOTIFY_WEEKLY_MS) : 6 * 86400000;
  ctx.weeklyIfDue = () => {
    const startHour = Number(notifier.settings('digest_hour') || 8);
    for (const u of q("SELECT * FROM users WHERE active=1 AND email!='' AND weekly_report=1").all()) {
      const now = ctx.localNow(u.timezone);
      const monday = new Date(`${now.day}T12:00:00Z`).getUTCDay() === 1 || process.env.NOTIFY_WEEKLY_ANYDAY === '1';
      if (!monday || now.hour < startHour || Date.now() - (Date.parse(u.weekly_last_at) || 0) < WEEK_MS) continue;
      q('UPDATE users SET weekly_last_at=? WHERE id=?').run(new Date().toISOString(), u.id);
      const text = weeklyText(u);
      if (text) notifier.enqueue({ userId: u.id, to: u.email, subject: 'Your week in Proofdeck', text, kind: 'weekly' });
    }
  };

  // Mostly for checking it looks right: send this week's email to yourself now.
  route('POST', '/api/auth/weekly-report/send', ({ user }) => {
    if (!user.email) throw new HttpError(400, 'Add your email address to your account first');
    const text = weeklyText(user);
    if (!text) throw new HttpError(400, 'There is nothing to report yet: no runs, bugs or reviews for you');
    notifier.enqueue({ userId: user.id, to: user.email, subject: 'Your week in Proofdeck', text, kind: 'weekly' });
    return { ok: true };
  }, { viewer: true });
}

module.exports = { install };
