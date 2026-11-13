'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { startAdmin, addUser, Client } = require('./helpers');

// A small OpenID provider: discovery, keys, an authorize step that answers at once, and a token endpoint that checks PKCE.
let idp, issuer, ctx, a, rsa, other, plan, pending;
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function sign(claims, { key = rsa.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' }), body = b64(claims);
  const sig = alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
before(async () => {
  rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  pending = new Map(); plan = { claims: {}, tamper: null };
  idp = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys` });
    if (u.pathname === '/keys') return json({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
    if (u.pathname === '/authorize') {
      const code = crypto.randomBytes(8).toString('hex');
      pending.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), client: u.searchParams.get('client_id'), redirect: u.searchParams.get('redirect_uri') });
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if (u.pathname === '/token') {
      let b = ''; req.on('data', (d) => { b += d; });
      return req.on('end', () => {
        const f = new URLSearchParams(b), p = pending.get(f.get('code'));
        pending.delete(f.get('code'));
        res.setHeader('Content-Type', 'application/json');
        const okPkce = p && crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === p.challenge;
        if (!p || !okPkce || f.get('client_secret') !== 'idp-secret' || f.get('redirect_uri') !== p.redirect) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code, PKCE or secret' })); }
        const t = Math.floor(Date.now() / 1000);
        const claims = { iss: issuer, aud: 'proofdeck-client', sub: 'sub-123', exp: t + 300, iat: t, nonce: p.nonce, email: 'sam@corp.example', email_verified: true, name: 'Sam Single', preferred_username: 'sam', ...plan.claims };
        res.end(JSON.stringify({ id_token: plan.tamper ? plan.tamper(claims) : sign(claims), access_token: 'x', token_type: 'Bearer' }));
      });
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${idp.address().port}`;
  ctx = await startAdmin({ PUBLIC_URL: 'http://127.0.0.1' }); // replaced below once the port is known
  a = ctx.admin;
});
after(() => { idp.close(); ctx.server.stop(); });

const settings = (extra = {}) => ({ enabled: true, issuer, clientId: 'proofdeck-client', clientSecret: 'idp-secret', label: 'Corp login', autoCreate: false, ...extra });
// Drives one sign-in the way a browser would: start, follow to the provider, come back with the cookie.
async function signIn({ tamperState = false, dropCookie = false, c = new Client(ctx.server.base) } = {}) {
  const raw = (u, cookie) => fetch(u, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  const start = await raw(`${ctx.server.base}/api/auth/oidc/login`);
  assert.equal(start.status, 302);
  const cookie = start.headers.getSetCookie().map((x) => x.split(';')[0]).find((x) => x.startsWith('pd_oidc='));
  const toIdp = new URL(start.headers.get('location'));
  assert.equal(toIdp.searchParams.get('code_challenge_method'), 'S256');
  const back = await raw(toIdp.toString());
  const cb = new URL(back.headers.get('location'));
  cb.protocol = 'http:'; cb.host = new URL(ctx.server.base).host; // the test server listens on its own port
  if (tamperState) cb.searchParams.set('state', 'forged');
  const done = await raw(cb.toString(), dropCookie ? '' : cookie);
  const html = await done.text();
  const session = done.headers.getSetCookie().map((x) => x.split(';')[0]).find((x) => x.startsWith('pd_session=') && !x.endsWith('='));
  if (session) c.cookie = session;
  return { c, html, session, error: (/sso_error=([^"&]+)/.exec(html) || [])[1] && decodeURIComponent(/sso_error=([^"&]+)/.exec(html)[1]) };
}

test('configuration is admin-only, validated, hides the secret, and can test the provider', async () => {
  const tess = await addUser(ctx.server, a, 'tess', 'tester');
  assert.equal((await tess.client.get('/api/settings/oidc')).status, 403);
  assert.equal((await a.put('/api/settings/oidc', settings({ clientSecret: '' }))).status, 400, 'enabling needs every field');
  assert.equal((await a.put('/api/settings/oidc', settings({ issuer: 'not a url' }))).status, 400);
  assert.equal((await a.put('/api/settings/oidc', settings({ scopes: 'email' }))).status, 400);
  assert.equal((await a.get('/api/auth/me')).data.sso.enabled, false);
  const t = await a.ok('POST', '/api/settings/oidc/test', { issuer });
  assert.deepEqual([t.ok, t.keys], [true, 1]);
  assert.equal((await a.post('/api/settings/oidc/test', { issuer: 'http://127.0.0.1:1' })).status, 400);
  const saved = await a.ok('PUT', '/api/settings/oidc', settings());
  assert.equal(saved.hasSecret, true);
  assert.ok(!JSON.stringify(saved).includes('idp-secret'));
  assert.match(saved.redirectUri, /\/api\/auth\/oidc\/callback$/);
  const me = (await new Client(ctx.server.base).get('/api/auth/me')).data;
  assert.deepEqual(me.sso, { enabled: true, label: 'Corp login' }, 'the sign-in page can show the button');
  assert.ok(!require('node:fs').readFileSync(require('node:path').join(ctx.server.dir, 'proofdeck.db')).includes('idp-secret'), 'secret stored encrypted');
});

test('no matching account and no auto-create: refused with a clear message', async () => {
  const r = await signIn();
  assert.equal(r.session, undefined);
  assert.match(r.error, /no Proofdeck account for you yet/);
});

test('a verified email links an existing account, then the identity sticks', async () => {
  await a.ok('POST', '/api/users', { username: 'samuel', display_name: 'Samuel Existing', email: 'Sam@Corp.example', role: 'tester', password: 'a long password 1' });
  const first = await signIn();
  assert.ok(first.session, 'signed in');
  const me = (await first.c.get('/api/auth/me')).data.user;
  assert.deepEqual([me.username, me.role], ['samuel', 'tester']);
  // change the email at the provider: the link on (issuer, sub) still finds the account
  plan.claims = { email: 'someone.else@corp.example' };
  const second = await signIn();
  assert.equal((await second.c.get('/api/auth/me')).data.user.username, 'samuel');
  plan.claims = {};
  // password sign-in still works for that account
  assert.equal((await new Client(ctx.server.base).post('/api/auth/login', { username: 'samuel', password: 'a long password 1' })).status, 200);
});

test('unverified email does not link; auto-create respects domains and never makes admins', async () => {
  plan.claims = { sub: 'sub-999', email: 'newbie@corp.example', email_verified: false, preferred_username: 'newbie' };
  await a.ok('PUT', '/api/settings/oidc', settings({ autoCreate: true, defaultRole: 'admin', allowedDomains: 'corp.example' }));
  assert.match((await signIn()).error, /did not confirm an email/);
  plan.claims = { sub: 'sub-999', email: 'newbie@evil.example', email_verified: true, preferred_username: 'newbie' };
  assert.match((await signIn()).error, /not allowed here/);
  plan.claims = { sub: 'sub-999', email: 'newbie@corp.example', email_verified: true, preferred_username: 'newbie', name: 'New Bie' };
  const r = await signIn();
  const me = (await r.c.get('/api/auth/me')).data.user;
  assert.deepEqual([me.username, me.display_name, me.email, me.role], ['newbie', 'New Bie', 'newbie@corp.example', 'tester'], 'default role never admin');
  // a second person who wants the same username gets another
  plan.claims = { sub: 'sub-1000', email: 'newbie2@corp.example', email_verified: true, preferred_username: 'newbie' };
  assert.equal((await (await signIn()).c.get('/api/auth/me')).data.user.username, 'newbie2');
  // inactive accounts are refused
  const id = (await a.get('/api/users')).data.find((u) => u.username === 'newbie2').id;
  await a.ok('PUT', `/api/users/${id}`, { active: false });
  assert.match((await signIn()).error, /switched off/);
  plan.claims = {};
});

test('forged state, a missing cookie, wrong signatures, wrong audience, expired and replayed tokens are all refused', async () => {
  await a.ok('PUT', '/api/settings/oidc', settings());
  assert.match((await signIn({ tamperState: true })).error, /expired or did not start in this browser/);
  assert.match((await signIn({ dropCookie: true })).error, /expired or did not start in this browser/);
  const bad = async (tamper, re) => { plan.tamper = tamper; const r = await signIn(); plan.tamper = null; assert.equal(r.session, undefined, re.toString()); assert.match(r.error, re); };
  await bad((c) => sign(c, { key: other.privateKey }), /signature is not valid/);
  await bad((c) => sign({ ...c, aud: 'someone-else' }), /different application/);
  await bad((c) => sign({ ...c, iss: 'https://evil.example' }), /issued by someone else/);
  await bad((c) => sign({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }), /expired/);
  await bad((c) => sign({ ...c, nonce: 'other' }), /does not belong to this sign-in/);
  await bad((c) => sign(c, { alg: 'none' }), /unsupported signature/);
  await bad((c) => sign(c, { kid: 'unknown' }), /key the provider does not publish/);
  // a code can be used once: replaying the callback fails
  const raw = (u, cookie) => fetch(u, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  const start = await raw(`${ctx.server.base}/api/auth/oidc/login`);
  const cookie = start.headers.getSetCookie()[0].split(';')[0];
  const back = await raw(start.headers.get('location'));
  const cb = new URL(back.headers.get('location')); cb.host = new URL(ctx.server.base).host; cb.protocol = 'http:';
  assert.ok((await (await raw(cb.toString(), cookie)).text()).includes('Signing in'));
  const again = await (await raw(cb.toString(), cookie)).text();
  assert.match(decodeURIComponent(again), /expired or did not start/);
});

test('single sign-on can be turned off; the login endpoint then refuses', async () => {
  await a.ok('PUT', '/api/settings/oidc', { ...settings(), clientSecret: '', enabled: false });
  assert.equal((await new Client(ctx.server.base).get('/api/auth/me')).data.sso.enabled, false);
  assert.equal((await fetch(`${ctx.server.base}/api/auth/oidc/login`, { redirect: 'manual' })).status, 404);
  assert.equal((await a.get('/api/settings/oidc')).data.hasSecret, true, 'the stored secret survives a save that leaves it blank');
});
