'use strict';
// Review and approval: a draft test case is sent to a named reviewer, who approves it or asks for changes.

function install(ctx) {
  const { route, q, tx, now, str, need, HttpError, notifier, versions } = ctx;
  const strictOn = (pid) => notifier.settings(`strict_approval:${pid}`) === '1';
  ctx.strictApproval = strictOn;

  route('GET', '/api/projects/:pid/workflow', ({ params }) => ({ strictApproval: strictOn(params.pid) }));
  route('PUT', '/api/projects/:pid/workflow', ({ params, body }) => {
    need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
    q('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`strict_approval:${params.pid}`, body.strictApproval ? '1' : '0');
    return { strictApproval: !!body.strictApproval };
  }, { admin: true });

  // Cases waiting for review; ?mine=1 for those assigned to the signed-in user.
  route('GET', '/api/projects/:pid/reviews', ({ params, query, user }) => q(`SELECT c.id, c.key, c.title, c.reviewer_id, c.updated_at,
      (SELECT display_name FROM users WHERE id=c.reviewer_id) AS reviewer_name, (SELECT display_name FROM users WHERE id=c.review_requested_by) AS requested_by_name
    FROM cases c WHERE c.project_id=? AND c.status='In Review' ${query.get('mine') ? 'AND c.reviewer_id=?' : ''} ORDER BY c.updated_at`).all(...(query.get('mine') ? [params.pid, user.id] : [params.pid])));

  route('POST', '/api/cases/:id/review', ({ params, body, user }) => {
    const c = need(q('SELECT * FROM cases WHERE id=?').get(params.id), 'Test case');
    const action = str(body.action), note = str(body.note).trim().slice(0, 2000);
    const link = `#/cases/${c.id}`;
    return tx(() => {
      if (action === 'request') {
        if (c.status !== 'Draft') throw new HttpError(400, `Only a Draft can be sent for review (this one is ${c.status})`);
        const reviewer = q('SELECT id, display_name, role FROM users WHERE id=? AND active=1').get(Number(body.reviewer_id));
        if (!reviewer) throw new HttpError(400, 'Choose who should review it');
        if (reviewer.id === user.id) throw new HttpError(400, 'Ask someone else to review it');
        if (reviewer.role === 'viewer') throw new HttpError(400, `${reviewer.display_name} has a read-only account and cannot approve`);
        q("UPDATE cases SET status='In Review', reviewer_id=?, review_requested_by=?, review_note=?, updated_at=? WHERE id=?").run(reviewer.id, user.id, note, now(), c.id);
        notifier.notify(reviewer.id, { kind: 'review-requested', title: `${user.display_name} asked you to review ${c.key}: ${c.title}`, body: note, link, projectId: c.project_id });
      } else {
        if (c.status !== 'In Review') throw new HttpError(400, 'This test case is not waiting for review');
        if (action === 'withdraw') {
          if (user.id !== c.review_requested_by && user.role !== 'admin') throw new HttpError(403, 'Only whoever asked for the review (or an admin) can withdraw it');
          q("UPDATE cases SET status='Draft', reviewer_id=NULL, updated_at=? WHERE id=?").run(now(), c.id);
        } else if (action === 'approve' || action === 'reject') {
          if (user.id !== c.reviewer_id && user.role !== 'admin') throw new HttpError(403, 'Only the chosen reviewer (or an admin) can decide');
          if (action === 'reject' && !note) throw new HttpError(400, 'Say what needs to change');
          if (action === 'approve') q("UPDATE cases SET status='Approved', approved_by=?, approved_at=?, review_note=?, updated_at=? WHERE id=?").run(user.id, now(), note, now(), c.id);
          else q("UPDATE cases SET status='Draft', review_note=?, updated_at=? WHERE id=?").run(note, now(), c.id);
          if (c.review_requested_by && c.review_requested_by !== user.id) {
            notifier.notify(c.review_requested_by, action === 'approve'
              ? { kind: 'review-approved', title: `${user.display_name} approved ${c.key}: ${c.title}`, body: note, link, projectId: c.project_id }
              : { kind: 'review-changes', title: `${user.display_name} asked for changes to ${c.key}: ${c.title}`, body: note, link, projectId: c.project_id });
          }
        } else throw new HttpError(400, 'Unknown review action');
      }
      q('UPDATE cases SET updated_by=? WHERE id=?').run(user.id, c.id);
      versions.recordVersion(c.id, user.id, { note: { request: 'Sent for review', withdraw: 'Review withdrawn', approve: 'Approved', reject: 'Changes requested' }[action] });
      return { status: q('SELECT status FROM cases WHERE id=?').get(c.id).status };
    });
  });
}

module.exports = { install };
