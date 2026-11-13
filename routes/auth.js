'use strict';
// Accounts: first-run setup, login/logout, password change and (admin) user management.

const crypto = require('node:crypto');
const auth = require('../lib/auth');
const { validEmail } = require('../lib/smtp');
const totp = require('../lib/totp');
const secret = require('../lib/secret');

let ctx;
const limiter = new auth.Limiter();
const ROLES = ['admin', 'tester', 'viewer'];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tokenOf = (req) => auth.parseCookies(req.headers.cookie)[auth.COOKIE] || '';
const publicUser = (u) => u && { id: u.id, username: u.username, display_name: u.display_name, role: u.role, email: u.email || '', notify_email: u.notify_email || 'instant', timezone: u.timezone || '', totp: !!u.totp_enabled };

// Returns the signed-in user (with _sid, the session hash) or null.
function userFromRequest(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const u = ctx.q(`SELECT u.*, s.last_seen_at AS _seen FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(sha(token), ctx.now());
  if (!u) return null;
  const { _seen, ...user } = u;
  if (!_seen || Date.now() - Date.parse(_seen) > 300000) ctx.q('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(ctx.now(), sha(token));
  return { ...user, _sid: sha(token) };
}

// Passwords that were right but still wait for a second factor. In memory on purpose: a restart just means signing in again.
const tickets = new Map();
function issueTicket(userId) {
  for (const [k, v] of tickets) if (v.expires < Date.now()) tickets.delete(k);
  const id = crypto.randomBytes(24).toString('base64url');
  tickets.set(id, { userId, expires: Date.now() + 300000, tries: 0 });
  return id;
}

// A six-digit code from the app (each 30 second step works once) or one of the one-time recovery codes.
function acceptSecondFactor(u, input) {
  const code = ctx.str(input).trim().toLowerCase();
  const step = totp.verify(secret.decrypt(u.totp_secret), code, { lastStep: u.totp_last_step });
  if (step) { ctx.q('UPDATE users SET totp_last_step=? WHERE id=?').run(step, u.id); return true; }
  const codes = JSON.parse(u.recovery_codes || '[]'), h = sha(code);
  if (/^[0-9a-f]{6}-[0-9a-f]{6}$/.test(code) && codes.includes(h)) {
    ctx.q('UPDATE users SET recovery_codes=? WHERE id=?').run(JSON.stringify(codes.filter((x) => x !== h)), u.id);
    return true;
  }
  return false;
}

function startSession(req, userId) {
  const { q, now } = ctx;
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  q('DELETE FROM sessions WHERE expires_at<=?').run(t);
  q('INSERT INTO sessions(token_hash, user_id, created_at, expires_at, ip, user_agent, last_seen_at) VALUES (?,?,?,?,?,?,?)')
    .run(sha(token), userId, t, new Date(Date.now() + auth.SESSION_DAYS * 86400000).toISOString(), ctx.security.clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200), t);
  return auth.sessionCookie(req, token);
}

const json = (obj, cookie) => new ctx.Raw(JSON.stringify(obj), {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}),
});

function cleanNewUser(body, { needPassword = true } = {}) {
  const { str, HttpError } = ctx;
  const username = str(body.username).trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Username must be 3-40 letters, digits, dots, dashes or underscores');
  const display = str(body.display_name).trim().slice(0, 80) || username;
  let password = null;
  if (needPassword || body.password) {
    password = str(body.password);
    const bad = auth.checkPassword(password, username);
    if (bad) throw new HttpError(400, bad);
  }
  return { username, display, password };
}

function activeAdmins(exceptId) {
  return ctx.q("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id!=?").get(exceptId).n;
}

function install(c) {
  ctx = c;
  const { route, q, tx, now, str, need, HttpError } = c;
  const userCount = () => q('SELECT COUNT(*) n FROM users').get().n;

  route('GET', '/api/auth/me', ({ user }) => ({ user: publicUser(user), needsSetup: userCount() === 0, resetAvailable: !!(ctx.resetAvailable && ctx.resetAvailable()) }), { public: true });

  route('POST', '/api/auth/setup', async ({ body, req }) => {
    if (userCount() > 0) throw new HttpError(403, 'Setup has already been completed');
    const v = cleanNewUser(body);
    const hash = await auth.hashPassword(v.password);
    const id = tx(() => {
      if (userCount() > 0) throw new HttpError(403, 'Setup has already been completed');
      return Number(q('INSERT INTO users(username, display_name, password_hash, role, created_at, last_login) VALUES (?,?,?,?,?,?)')
        .run(v.username, v.display, hash, 'admin', now(), now()).lastInsertRowid);
    });
    ctx.security.loginEvent(req, { username: v.username, userId: id, ok: true, reason: 'first-run setup' });
    return json({ user: publicUser(q('SELECT * FROM users WHERE id=?').get(id)) }, startSession(req, id));
  }, { public: true });

  route('POST', '/api/auth/login', async ({ body, req }) => {
    const username = str(body.username).trim().slice(0, 80);
    const password = str(body.password).slice(0, auth.MAX_PASSWORD + 1);
    const key = `${req.socket.remoteAddress}|${username.toLowerCase()}`;
    const wait = limiter.blocked(key);
    if (wait) { ctx.security.loginEvent(req, { username, ok: false, reason: 'blocked: too many attempts' }); throw new HttpError(429, `Too many failed attempts. Try again in ${wait} seconds.`); }
    const u = q('SELECT * FROM users WHERE username=?').get(username);
    const good = await auth.verifyPassword(password, u ? u.password_hash : await auth.dummyHash());
    if (!u || !good || !u.active) {
      limiter.fail(key);
      ctx.security.loginEvent(req, { username, userId: u ? u.id : null, ok: false, reason: !u ? 'unknown user' : !good ? 'wrong password' : 'account is inactive' });
      throw new HttpError(401, 'Wrong username or password');
    }
    limiter.ok(key);
    if (u.totp_enabled) return json({ needs2fa: true, ticket: issueTicket(u.id) }); // the password was right; a code from the authenticator app is still needed
    ctx.security.loginEvent(req, { username, userId: u.id, ok: true });
    q('UPDATE users SET last_login=? WHERE id=?').run(now(), u.id);
    return json({ user: publicUser(u) }, startSession(req, u.id));
  }, { public: true });

  // Second step of signing in. The ticket proves the password was right, lasts five minutes, and dies after five wrong codes.
  route('POST', '/api/auth/login/2fa', ({ body, req }) => {
    const t = tickets.get(str(body.ticket));
    if (!t || t.expires < Date.now()) { tickets.delete(str(body.ticket)); throw new HttpError(401, 'That sign-in timed out. Enter your password again.'); }
    const u = q('SELECT * FROM users WHERE id=? AND active=1').get(t.userId);
    const fail = (why) => {
      t.tries++;
      ctx.security.loginEvent(req, { username: u ? u.username : '', userId: u ? u.id : null, ok: false, reason: why });
      if (t.tries >= 5) { tickets.delete(str(body.ticket)); throw new HttpError(401, 'Too many wrong codes. Enter your password again.'); }
      throw new HttpError(401, 'That code is not right');
    };
    if (!u || !u.totp_enabled) throw new HttpError(401, 'Sign in again');
    // Wrong codes count against the account, not only the ticket, so asking for fresh tickets does not help a guesser.
    const wait = limiter.blocked(`2fa|${u.id}`);
    if (wait) throw new HttpError(429, `Too many wrong codes. Try again in ${wait} seconds.`);
    if (!acceptSecondFactor(u, body.code)) { limiter.fail(`2fa|${u.id}`); return fail('wrong two-factor code'); }
    limiter.ok(`2fa|${u.id}`);
    tickets.delete(str(body.ticket));
    ctx.security.loginEvent(req, { username: u.username, userId: u.id, ok: true, reason: 'two-factor' });
    q('UPDATE users SET last_login=? WHERE id=?').run(now(), u.id);
    return json({ user: publicUser(u) }, startSession(req, u.id));
  }, { public: true });

  // ----- two-factor sign-in (authenticator app) -----
  // Step 1: make a secret and show it. Nothing is enforced until the person proves their app works (step 2).
  route('POST', '/api/auth/2fa/setup', ({ user }) => {
    if (user.totp_enabled) throw new HttpError(400, 'Two-factor sign-in is already on');
    const s = totp.newSecret();
    q('UPDATE users SET totp_secret=? WHERE id=?').run(secret.encrypt(s), user.id);
    return { secret: s, uri: totp.uri(s, user.username) };
  }, { viewer: true });

  route('POST', '/api/auth/2fa/enable', ({ body, user }) => {
    const u = q('SELECT * FROM users WHERE id=?').get(user.id);
    if (u.totp_enabled) throw new HttpError(400, 'Two-factor sign-in is already on');
    if (!u.totp_secret) throw new HttpError(400, 'Start the setup first');
    const step = totp.verify(secret.decrypt(u.totp_secret), str(body.code));
    if (!step) throw new HttpError(400, 'That code is not right. Check the clock on your phone and try the next code.');
    const codes = Array.from({ length: 10 }, () => `${crypto.randomBytes(3).toString('hex')}-${crypto.randomBytes(3).toString('hex')}`);
    q('UPDATE users SET totp_enabled=1, totp_last_step=?, recovery_codes=? WHERE id=?').run(step, JSON.stringify(codes.map(sha)), u.id);
    return { recoveryCodes: codes }; // shown once; only their hashes are kept
  }, { viewer: true });

  route('POST', '/api/auth/2fa/disable', async ({ body, user }) => {
    const u = q('SELECT * FROM users WHERE id=?').get(user.id);
    if (!u.totp_enabled) return { ok: true };
    if (!(await auth.verifyPassword(str(body.password).slice(0, auth.MAX_PASSWORD + 1), u.password_hash))) throw new HttpError(400, 'Wrong password');
    if (!acceptSecondFactor(u, body.code)) throw new HttpError(400, 'That code is not right');
    q("UPDATE users SET totp_enabled=0, totp_secret='', totp_last_step=0, recovery_codes='[]' WHERE id=?").run(u.id);
    return { ok: true };
  }, { viewer: true });

  // Locked out of their authenticator? An admin can switch it off so they can sign in and set it up again.
  route('POST', '/api/users/:id/2fa-reset', ({ params }) => {
    need(q('SELECT 1 FROM users WHERE id=?').get(params.id), 'User');
    q("UPDATE users SET totp_enabled=0, totp_secret='', totp_last_step=0, recovery_codes='[]' WHERE id=?").run(params.id);
    return { ok: true };
  }, { admin: true });

  route('POST', '/api/auth/logout', ({ user, req }) => {
    q('DELETE FROM sessions WHERE token_hash=?').run(user._sid);
    return json({ ok: true }, auth.clearCookie(req));
  }, { viewer: true });

  route('POST', '/api/auth/password', async ({ user, body }) => {
    if (!(await auth.verifyPassword(str(body.current).slice(0, auth.MAX_PASSWORD + 1), user.password_hash))) throw new HttpError(400, 'Current password is wrong');
    const next = str(body.next);
    const bad = auth.checkPassword(next, user.username);
    if (bad) throw new HttpError(400, bad);
    const hash = await auth.hashPassword(next);
    tx(() => {
      q('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
      q('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, user._sid); // sign out everywhere else
    });
    return { ok: true };
  }, { viewer: true });

  // Your own contact details and how you want to hear about things.
  route('PUT', '/api/auth/profile', ({ body, user }) => {
    const sets = [], vals = [];
    if (body.email !== undefined) {
      const email = str(body.email).trim();
      if (email && !validEmail(email)) throw new HttpError(400, 'That does not look like an email address');
      sets.push('email=?'); vals.push(email);
    }
    if (body.notify_email !== undefined) {
      if (!['instant', 'daily', 'off'].includes(body.notify_email)) throw new HttpError(400, 'Choose instant, daily or off');
      sets.push('notify_email=?'); vals.push(body.notify_email);
    }
    if (body.timezone !== undefined) {
      const tz = str(body.timezone).trim();
      if (tz && !ctx.validZone(tz)) throw new HttpError(400, 'That time zone is not recognised');
      sets.push('timezone=?'); vals.push(tz);
    }
    if (sets.length) q(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals, user.id);
    return { user: publicUser(q('SELECT * FROM users WHERE id=?').get(user.id)) };
  }, { viewer: true });

  // Everyone signed in can list active users (for assignee pickers); admins also see roles and inactive accounts.
  route('GET', '/api/users', ({ user }) => {
    if (user.role !== 'admin') return q('SELECT id, username, display_name FROM users WHERE active=1 ORDER BY display_name COLLATE NOCASE').all();
    return q('SELECT id, username, display_name, email, role, active, created_at, last_login, totp_enabled AS totp FROM users ORDER BY active DESC, display_name COLLATE NOCASE').all();
  });

  route('POST', '/api/users', async ({ body }) => {
    const v = cleanNewUser(body);
    const role = str(body.role, 'tester');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
    if (q('SELECT 1 FROM users WHERE username=?').get(v.username)) throw new HttpError(409, `The username “${v.username}” is taken`);
    const hash = await auth.hashPassword(v.password);
    const email = str(body.email).trim();
    if (email && !validEmail(email)) throw new HttpError(400, 'That does not look like an email address');
    const id = Number(q('INSERT INTO users(username, display_name, password_hash, role, created_at, email) VALUES (?,?,?,?,?,?)')
      .run(v.username, v.display, hash, role, now(), email).lastInsertRowid);
    return { id };
  }, { admin: true });

  route('PUT', '/api/users/:id', async ({ params, body }) => {
    const u = need(q('SELECT * FROM users WHERE id=?').get(params.id), 'User');
    const sets = [], vals = [];
    if (body.display_name !== undefined) {
      const d = str(body.display_name).trim().slice(0, 80);
      if (!d) throw new HttpError(400, 'Name is required');
      sets.push('display_name=?'); vals.push(d);
    }
    if (body.email !== undefined) {
      const email = str(body.email).trim();
      if (email && !validEmail(email)) throw new HttpError(400, 'That does not look like an email address');
      sets.push('email=?'); vals.push(email);
    }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw new HttpError(400, 'Invalid role');
      if (u.role === 'admin' && body.role !== 'admin' && u.active && !activeAdmins(u.id)) throw new HttpError(400, 'There must be at least one active admin');
      sets.push('role=?'); vals.push(body.role);
    }
    if (body.active !== undefined) {
      const a = body.active ? 1 : 0;
      if (!a && u.role === 'admin' && u.active && !activeAdmins(u.id)) throw new HttpError(400, 'There must be at least one active admin');
      sets.push('active=?'); vals.push(a);
    }
    let resetPassword = false;
    if (body.password) {
      const bad = auth.checkPassword(str(body.password), u.username);
      if (bad) throw new HttpError(400, bad);
      sets.push('password_hash=?'); vals.push(await auth.hashPassword(str(body.password)));
      resetPassword = true;
    }
    tx(() => {
      if (sets.length) q(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals, u.id);
      if (resetPassword || body.active === false || body.active === 0) q('DELETE FROM sessions WHERE user_id=?').run(u.id);
    });
    return { ok: true };
  }, { admin: true });
}

module.exports = { install, userFromRequest, publicUser };
