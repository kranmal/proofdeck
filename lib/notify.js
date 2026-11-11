'use strict';
// Creates in-app notifications and, for people who want email, queues it in the outbox. Sending happens in the
// background worker (routes/notifications.js), so a slow or broken mail server never slows a request down.

module.exports = function makeNotifier({ q, now, str }) {
  const settings = (key) => { const r = q('SELECT value FROM settings WHERE key=?').get(key); return r ? r.value : ''; };
  const publicUrl = () => (settings('public_url') || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  const hooks = { kick: () => {} }; // replaced by the worker

  function enqueue({ userId = null, to, subject, text, kind }) {
    q('INSERT INTO outbox(user_id, to_addr, subject, body, kind, created_at) VALUES (?,?,?,?,?,?)').run(userId, to, String(subject).slice(0, 300), text, kind, now());
    hooks.kick();
  }

  function emailText({ title, body, link }) {
    const base = publicUrl();
    return [title, body && `\n${body}`, link && base ? `\nOpen it: ${base}/${link}` : '', '\n--\nProofdeck. You can change how often you get these emails from your account menu.'].filter(Boolean).join('\n');
  }

  // Returns the notification id, or null when the person cannot be notified.
  function notify(userId, { kind, title, body = '', link = '', projectId = null }) {
    const u = userId ? q('SELECT id, email, notify_email, active FROM users WHERE id=?').get(userId) : null;
    if (!u || !u.active) return null;
    const id = Number(q('INSERT INTO notifications(user_id, project_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(u.id, projectId, kind, String(title).slice(0, 300), String(body).slice(0, 5000), link, now()).lastInsertRowid);
    if (u.email && u.notify_email === 'instant') enqueue({ userId: u.id, to: u.email, subject: title, text: emailText({ title, body, link }), kind });
    return id;
  }

  // @username mentions in free text, resolved to active users.
  function mentions(text) {
    const names = [...new Set([...str(text).matchAll(/(?:^|[^\w@])@([A-Za-z0-9._-]{3,40})/g)].map((m) => m[1].toLowerCase().replace(/[.]+$/, '')))];
    return names.map((n) => q('SELECT id FROM users WHERE username=? AND active=1').get(n)).filter(Boolean).map((u) => u.id);
  }

  return { notify, enqueue, emailText, mentions, settings, publicUrl, hooks };
};
