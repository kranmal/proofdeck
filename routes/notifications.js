'use strict';
// In-app notifications, email settings, the background mail worker and password reset by email.

const crypto = require('node:crypto');
const auth = require('../lib/auth');
const secret = require('../lib/secret');
const { sendMail, validEmail, SmtpError } = require('../lib/smtp');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const MAX_ATTEMPTS = 5;
const RESET_MINUTES = 60;

function install(ctx) {
  const { route, q, tx, db, now, str, need, HttpError, notifier } = ctx;
  const TICK_MS = Number(process.env.NOTIFY_TICK_MS) || 10000;
  const BACKOFF_MS = Number(process.env.NOTIFY_BACKOFF_MS) || 60000;

  // ---------- settings ----------
  const getSetting = (k) => notifier.settings(k);
  const setSetting = (k, v) => q('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

  function smtpConfig() {
    let c;
    try { c = JSON.parse(getSetting('smtp') || 'null'); } catch { c = null; }
    if (!c || !c.host) return null;
    return { host: c.host, port: c.port, security: c.security, user: c.user || '', pass: c.passEnc ? (secret.decrypt(c.passEnc) || '') : '', from: c.from, fromName: c.fromName || '', tlsVerify: c.tlsVerify !== false };
  }
  const resetAvailable = () => !!(smtpConfig() && notifier.publicUrl());
  const mailFrom = (cfg, to, subject, text) => ({ from: cfg.from, fromName: cfg.fromName, to, subject, text });

  function cleanSmtp(input, existing) {
    const s = input && typeof input === 'object' ? input : {};
    const host = str(s.host).trim();
    if (!host) return null; // no host = email switched off
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Enter a port number between 1 and 65535 (usually 587 or 465)');
    const security = str(s.security, 'starttls');
    if (!['none', 'starttls', 'tls'].includes(security)) throw new HttpError(400, 'Security must be none, starttls or tls');
    const from = str(s.from).trim();
    if (!validEmail(from)) throw new HttpError(400, 'Enter the address emails should come from, for example proofdeck@yourcompany.com');
    const user = str(s.user).trim();
    const password = str(s.password);
    const passEnc = password ? secret.encrypt(password) : (existing && existing.user === user ? existing.passEnc : '');
    return { host, port, security, user, passEnc: user ? passEnc : '', from, fromName: str(s.fromName).trim().slice(0, 80), tlsVerify: s.tlsVerify !== false };
  }
  const savedSmtp = () => { try { return JSON.parse(getSetting('smtp') || 'null'); } catch { return null; } };

  const settingsView = () => {
    const c = savedSmtp();
    return {
      smtp: c && c.host ? { host: c.host, port: c.port, security: c.security, user: c.user, hasPassword: !!c.passEnc, from: c.from, fromName: c.fromName, tlsVerify: c.tlsVerify !== false } : null,
      publicUrl: getSetting('public_url'), envPublicUrl: process.env.PUBLIC_URL || '', digestHour: Number(getSetting('digest_hour') || 8), configured: !!smtpConfig(), resetAvailable: resetAvailable(),
    };
  };

  route('GET', '/api/settings/notifications', () => settingsView(), { admin: true });

  route('PUT', '/api/settings/notifications', ({ body }) => {
    // A field that is not sent is left as it is; an empty mail host switches email off.
    const smtp = body.smtp === undefined ? undefined : cleanSmtp(body.smtp, savedSmtp());
    let url = body.publicUrl === undefined ? getSetting('public_url') : str(body.publicUrl).trim().replace(/\/+$/, '');
    if (url && body.publicUrl !== undefined) {
      let u; try { u = new URL(url); } catch { throw new HttpError(400, 'The public address must be a full URL such as https://proofdeck.yourcompany.com'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.search || u.hash || u.username) throw new HttpError(400, 'The public address must be a plain http(s) URL with no query, fragment or credentials');
      url = u.origin + u.pathname.replace(/\/+$/, '');
    }
    const hour = body.digestHour === undefined ? Number(getSetting('digest_hour') || 8) : Number(body.digestHour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new HttpError(400, 'Digest hour must be 0 to 23');
    tx(() => { if (smtp !== undefined) setSetting('smtp', smtp ? JSON.stringify(smtp) : ''); setSetting('public_url', url); setSetting('digest_hour', hour); });
    return settingsView();
  }, { admin: true });

  route('POST', '/api/settings/notifications/test', async ({ body }) => {
    const to = str(body.to).trim();
    if (!validEmail(to)) throw new HttpError(400, 'Enter the address to send the test to');
    const saved = savedSmtp();
    const draft = body.smtp && body.smtp.host ? cleanSmtp(body.smtp, saved) : saved;
    if (!draft || !draft.host) throw new HttpError(400, 'Fill in the mail server first');
    const cfg = { host: draft.host, port: draft.port, security: draft.security, user: draft.user, pass: draft.passEnc ? (secret.decrypt(draft.passEnc) || '') : '', from: draft.from, fromName: draft.fromName, tlsVerify: draft.tlsVerify !== false };
    try { await sendMail(cfg, mailFrom(cfg, to, 'Proofdeck test email', 'This is a test from Proofdeck. If you can read it, email is set up correctly.')); }
    catch (e) { if (e instanceof SmtpError) throw new HttpError(502, e.message); throw e; }
    return { ok: true };
  }, { admin: true });

  // ---------- in-app notifications ----------
  route('GET', '/api/notifications', ({ query, user }) => {
    const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 50));
    const items = q(`SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id=? ${query.get('unread') ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`).all(user.id, limit);
    return { items, unread: q('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL').get(user.id).n };
  });
  route('GET', '/api/notifications/unread-count', ({ user }) => ({ count: q('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL').get(user.id).n }));
  route('POST', '/api/notifications/read', ({ body, user }) => {
    if (body.all) return { marked: Number(q('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), user.id).changes) };
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
    let n = 0;
    for (const id of ids) n += Number(q('UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL').run(now(), id, user.id).changes);
    return { marked: n };
  }, { viewer: true });

  // ---------- password reset by email ----------
  const attempts = new Map(); // "ip|x" -> [timestamps] for the forgot form
  const tooMany = (key, max) => {
    const hourAgo = Date.now() - 3600000;
    const list = (attempts.get(key) || []).filter((t) => t > hourAgo);
    list.push(Date.now());
    attempts.set(key, list);
    if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some((t) => t > hourAgo)) attempts.delete(k);
    return list.length > max;
  };
  const badResets = new auth.Limiter();

  route('POST', '/api/auth/forgot', ({ body, req }) => {
    if (!resetAvailable()) throw new HttpError(400, 'Password reset by email is not set up here. Ask an admin to reset your password.');
    const id = str(body.identifier).trim().slice(0, 254);
    if (!id) throw new HttpError(400, 'Enter your username or email address');
    const ip = req.socket.remoteAddress || '';
    if (tooMany(`ip|${ip}`, 10) || tooMany(`id|${id.toLowerCase()}`, 3)) throw new HttpError(429, 'Too many requests. Try again in an hour.');
    // The answer is the same whether or not anyone matches, so this cannot be used to find usernames.
    const users = q("SELECT id, username, email FROM users WHERE active=1 AND email!='' AND (username=? OR email=? COLLATE NOCASE) LIMIT 3").all(id, id);
    for (const u of users) {
      const token = crypto.randomBytes(32).toString('base64url');
      tx(() => {
        q('DELETE FROM password_resets WHERE user_id=? AND used_at IS NULL').run(u.id);
        q('INSERT INTO password_resets(token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(sha(token), u.id, new Date(Date.now() + RESET_MINUTES * 60000).toISOString(), now());
        notifier.enqueue({ userId: u.id, to: u.email, subject: 'Reset your Proofdeck password', kind: 'reset',
          text: `Someone asked to reset the password for ${u.username}.\n\nTo choose a new one, open this link within ${RESET_MINUTES} minutes:\n${notifier.publicUrl()}/#/reset/${token}\n\nIf this was not you, ignore this email. Your password stays as it is.` });
      });
    }
    return { ok: true, message: 'If an account matches, an email with a reset link is on its way.' };
  }, { public: true });

  route('POST', '/api/auth/reset', async ({ body, req }) => {
    const ip = req.socket.remoteAddress || '';
    const wait = badResets.blocked(ip);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} seconds.`);
    const row = q('SELECT r.token_hash, r.user_id, r.expires_at, r.used_at, u.username, u.active FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=?').get(sha(str(body.token).slice(0, 200)));
    if (!row || row.used_at || !row.active || row.expires_at <= now()) { badResets.fail(ip); throw new HttpError(400, 'This reset link is invalid or has expired. Ask for a new one.'); }
    const bad = auth.checkPassword(str(body.password), row.username);
    if (bad) throw new HttpError(400, bad);
    const hash = await auth.hashPassword(str(body.password));
    tx(() => {
      q('UPDATE users SET password_hash=? WHERE id=?').run(hash, row.user_id);
      q('UPDATE password_resets SET used_at=? WHERE token_hash=?').run(now(), row.token_hash);
      q('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
    });
    badResets.ok(ip);
    return { ok: true };
  }, { public: true });

  // ---------- background worker ----------
  let busy = false;
  async function sendOutbox() {
    const cfg = smtpConfig();
    if (!cfg) return;
    const due = q("SELECT * FROM outbox WHERE state='pending' AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT 10").all(now());
    for (const m of due) {
      const n = m.attempts + 1;
      try {
        await sendMail(cfg, mailFrom(cfg, m.to_addr, m.subject, m.body));
        // The text is not kept once delivered: reset links and digests do not need to sit in the database.
        q("UPDATE outbox SET state='sent', attempts=?, sent_at=?, error='', body='' WHERE id=?").run(n, now(), m.id);
        if (m.kind === 'reset') { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy: the next checkpoint will do it */ } }
      } catch (e) {
        const msg = (e instanceof SmtpError ? e.message : `Unexpected error: ${e.message}`).slice(0, 300);
        if (n >= MAX_ATTEMPTS) q("UPDATE outbox SET state='failed', attempts=?, error=?, body=CASE WHEN kind='reset' THEN '' ELSE body END WHERE id=?").run(n, msg, m.id);
        else q("UPDATE outbox SET attempts=?, error=?, next_at=? WHERE id=?").run(n, msg, new Date(Date.now() + BACKOFF_MS * 2 ** (n - 1)).toISOString(), m.id);
      }
    }
  }

  // A digest goes out when it is after the chosen hour and at least ~a day since the last one (survives restarts).
  const DIGEST_MS = process.env.NOTIFY_DIGEST_MS !== undefined ? Number(process.env.NOTIFY_DIGEST_MS) : 23 * 3600000;
  function digestIfDue() {
    const d = new Date();
    const last = Date.parse(getSetting('digest_last_at') || '') || 0;
    if (!smtpConfig() || Date.now() - last < DIGEST_MS || d.getHours() < Number(getSetting('digest_hour') || 8)) return;
    for (const u of q("SELECT id, email, digest_cursor FROM users WHERE active=1 AND email!='' AND notify_email='daily'").all()) {
      const rows = q('SELECT id, title, body, link, created_at FROM notifications WHERE user_id=? AND id>? ORDER BY id LIMIT 200').all(u.id, u.digest_cursor);
      if (!rows.length) continue;
      const base = notifier.publicUrl();
      const text = [`You have ${rows.length} update${rows.length === 1 ? '' : 's'} in Proofdeck:`, '',
        ...rows.map((r) => `- ${r.title}${r.link && base ? `\n  ${base}/${r.link}` : ''}`), '', '--', 'Change how often you get these emails from your account menu.'].join('\n');
      tx(() => {
        notifier.enqueue({ userId: u.id, to: u.email, subject: `Proofdeck: ${rows.length} update${rows.length === 1 ? '' : 's'}`, text, kind: 'digest' });
        q('UPDATE users SET digest_cursor=? WHERE id=?').run(rows[rows.length - 1].id, u.id);
      });
    }
    setSetting('digest_last_at', new Date().toISOString());
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try { digestIfDue(); await sendOutbox(); } catch (e) { console.error('notification worker:', e.message); } finally { busy = false; }
  }
  ctx.resetAvailable = resetAvailable;
  notifier.hooks.kick = () => setImmediate(tick);
  setInterval(tick, TICK_MS).unref();
}

module.exports = { install };
