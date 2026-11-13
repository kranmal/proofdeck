'use strict';
// Single sign-on with any OpenID Connect provider (Google, Microsoft Entra, Okta, Keycloak, Authentik, ...).
// Password sign-in stays available, so a broken provider never locks everyone out.

const crypto = require('node:crypto');
const auth = require('../lib/auth');
const oidc = require('../lib/oidc');
const secret = require('../lib/secret');

const COOKIE = 'pd_oidc';
const flows = new Map(); // state -> { nonce, verifier, redirectUri, expires }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function install(ctx) {
  const { route, q, tx, now, str, need, HttpError, notifier } = ctx;

  const read = () => { try { return JSON.parse(notifier.settings('oidc') || '{}'); } catch { return {}; } };
  const write = (v) => q('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('oidc', JSON.stringify(v));
  const ready = (c) => !!(c.enabled && c.issuer && c.clientId && c.clientSecret);
  const baseUrl = (req) => {
    const fixed = notifier.publicUrl();
    if (fixed) return fixed;
    const proto = process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http';
    return `${proto}://${req.headers.host}`;
  };
  const redirectUri = (req) => `${baseUrl(req)}/api/auth/oidc/callback`;
  ctx.ssoInfo = () => { const c = read(); return ready(c) ? { enabled: true, label: c.label || 'Single sign-on' } : { enabled: false }; };

  const view = (c, req) => ({
    enabled: !!c.enabled, issuer: c.issuer || '', clientId: c.clientId || '', hasSecret: !!c.clientSecret, label: c.label || '', scopes: c.scopes || 'openid email profile',
    autoCreate: !!c.autoCreate, defaultRole: c.defaultRole || 'tester', allowedDomains: c.allowedDomains || '', redirectUri: redirectUri(req),
  });

  route('GET', '/api/settings/oidc', ({ req }) => view(read(), req), { admin: true });

  route('PUT', '/api/settings/oidc', ({ body, req }) => {
    const old = read();
    const c = {
      enabled: !!body.enabled,
      issuer: str(body.issuer).trim().replace(/\/+$/, ''),
      clientId: str(body.clientId).trim().slice(0, 300),
      clientSecret: body.clientSecret ? secret.encrypt(str(body.clientSecret).slice(0, 500)) : old.clientSecret || '',
      label: str(body.label).trim().slice(0, 40),
      scopes: str(body.scopes, 'openid email profile').trim().slice(0, 200) || 'openid email profile',
      autoCreate: !!body.autoCreate,
      defaultRole: ['tester', 'viewer'].includes(body.defaultRole) ? body.defaultRole : 'tester', // never admin: promote people by hand
      allowedDomains: str(body.allowedDomains).toLowerCase().replace(/[^a-z0-9.,\- ]/g, '').trim().slice(0, 500),
    };
    if (c.issuer) { try { if (!/^https?:$/.test(new URL(c.issuer).protocol)) throw new Error(); } catch { throw new HttpError(400, 'The issuer must be a web address such as https://accounts.example.com'); } }
    if (c.enabled && (!c.issuer || !c.clientId || !c.clientSecret)) throw new HttpError(400, 'Enter the issuer, client ID and client secret before turning it on');
    if (!c.scopes.split(/\s+/).includes('openid')) throw new HttpError(400, 'The scopes must include openid');
    write(c);
    oidc.clearCache();
    return view(c, req);
  }, { admin: true });

  // Checks the provider answers and describes itself the way we expect.
  route('POST', '/api/settings/oidc/test', async ({ body }) => {
    const issuer = str(body.issuer, read().issuer).trim();
    if (!issuer) throw new HttpError(400, 'Enter the issuer first');
    oidc.clearCache();
    try {
      const d = await oidc.discover(issuer);
      const keys = (await oidc.getJson(d.jwks_uri, 0)).keys || [];
      return { ok: true, authorization: d.authorization_endpoint, token: d.token_endpoint, keys: keys.length };
    } catch (e) { throw new HttpError(400, `Could not reach the provider: ${e.message}`); }
  }, { admin: true });

  const interstitial = (target, cookies) => new ctx.Raw(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Signing in…</title><p>Signing in… <a href="${target}">Continue</a></p>`,
    { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': cookies });
  const problem = (req, message) => interstitial(`/?sso_error=${encodeURIComponent(message)}`, [`${COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=0`]);

  // Step 1: send the browser to the provider.
  route('GET', '/api/auth/oidc/login', async ({ req }) => {
    const c = read();
    if (!ready(c)) throw new HttpError(404, 'Single sign-on is not set up');
    let d;
    try { d = await oidc.discover(c.issuer); } catch (e) { return problem(req, `Single sign-on is unavailable: ${e.message}`); }
    for (const [k, v] of flows) if (v.expires < Date.now()) flows.delete(k);
    const state = crypto.randomBytes(24).toString('base64url'), nonce = crypto.randomBytes(24).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url');
    flows.set(state, { nonce, verifier, redirectUri: redirectUri(req), expires: Date.now() + 600000 });
    const url = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: c.clientId, redirect_uri: redirectUri(req), scope: c.scopes || 'openid email profile', state, nonce, code_challenge: oidc.pkceChallenge(verifier), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
    // The cookie ties the answer to this browser, so someone cannot feed a victim a sign-in they started.
    return new ctx.Raw('', { Location: url.toString(), 'Cache-Control': 'no-store', 'Set-Cookie': `${COOKIE}=${sha(state)}; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=600${auth.secureCookies(req) ? '; Secure' : ''}` }, 302);
  }, { public: true });

  const username = (claims) => {
    let base = String(claims.preferred_username || str(claims.email).split('@')[0] || 'user').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 36) || 'user';
    if (base.length < 3) base = `${base}user`.slice(0, 40);
    let name = base, n = 1;
    while (q('SELECT 1 FROM users WHERE username=?').get(name)) name = `${base.slice(0, 36)}${++n}`;
    return name;
  };

  // Step 2: the provider sends the person back with a code, which we trade for a signed ID token.
  route('GET', '/api/auth/oidc/callback', async ({ query, req }) => {
    const c = read();
    if (!ready(c)) return problem(req, 'Single sign-on is not set up');
    const state = query.get('state') || '';
    const flow = flows.get(state);
    flows.delete(state); // one use
    const cookie = auth.parseCookies(req.headers.cookie)[COOKIE];
    if (!flow || flow.expires < Date.now() || !cookie || cookie !== sha(state)) return problem(req, 'That sign-in expired or did not start in this browser. Try again.');
    if (query.get('error')) return problem(req, `The provider said: ${query.get('error_description') || query.get('error')}`);
    const code = query.get('code');
    if (!code) return problem(req, 'The provider did not send a code');
    let claims;
    try {
      const d = await oidc.discover(c.issuer);
      const res = await fetch(d.token_endpoint, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, client_id: c.clientId, client_secret: secret.decrypt(c.clientSecret), code_verifier: flow.verifier }),
      });
      const tok = await res.json().catch(() => ({}));
      if (!res.ok || !tok.id_token) throw new Error(tok.error_description || tok.error || `the token request answered ${res.status}`);
      claims = await oidc.verifyIdToken(tok.id_token, { issuer: d.issuer, jwksUri: d.jwks_uri, clientId: c.clientId, nonce: flow.nonce });
    } catch (e) {
      ctx.security.loginEvent(req, { username: '', ok: false, reason: `single sign-on failed: ${e.message}`.slice(0, 200) });
      return problem(req, `Sign-in failed: ${e.message}`);
    }

    const email = str(claims.email).trim().toLowerCase(), verified = claims.email_verified === true || claims.email_verified === 'true';
    let user = q('SELECT * FROM users WHERE oidc_issuer=? AND oidc_sub=?').get(d_issuer(c), claims.sub);
    if (!user && email && verified) {
      const byEmail = q("SELECT * FROM users WHERE lower(email)=? AND oidc_sub=''").all(email);
      if (byEmail.length === 1) { user = byEmail[0]; q('UPDATE users SET oidc_issuer=?, oidc_sub=? WHERE id=?').run(d_issuer(c), claims.sub, user.id); }
    }
    if (!user) {
      const domain = email.split('@')[1] || '';
      const allowed = (c.allowedDomains || '').split(/[\s,]+/).filter(Boolean);
      if (!c.autoCreate) return problem(req, 'There is no Proofdeck account for you yet. Ask an admin to add one with your email address.');
      if (!email || !verified) return problem(req, 'Your provider did not confirm an email address, so an account cannot be created.');
      if (allowed.length && !allowed.includes(domain)) return problem(req, `Accounts for ${domain} are not allowed here.`);
      const hash = await auth.hashPassword(crypto.randomBytes(32).toString('base64url')); // nobody knows it: this account signs in through the provider
      const id = tx(() => Number(q('INSERT INTO users(username, display_name, email, password_hash, role, created_at, last_login, oidc_issuer, oidc_sub) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(username(claims), str(claims.name).trim().slice(0, 80) || email.split('@')[0], email, hash, c.defaultRole || 'tester', now(), now(), d_issuer(c), claims.sub).lastInsertRowid));
      user = q('SELECT * FROM users WHERE id=?').get(id);
    }
    if (!user.active) { ctx.security.loginEvent(req, { username: user.username, userId: user.id, ok: false, reason: 'account is inactive' }); return problem(req, 'This account is switched off. Ask an admin.'); }
    ctx.security.loginEvent(req, { username: user.username, userId: user.id, ok: true, reason: 'single sign-on' });
    q('UPDATE users SET last_login=? WHERE id=?').run(now(), user.id);
    // The provider has already done any second factor, so ours is not asked for again.
    return interstitial('/', [ctx.startSession(req, user.id), `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=0`]);
  }, { public: true });

  function d_issuer(c) { return c.issuer.replace(/\/+$/, ''); }
}

module.exports = { install };
