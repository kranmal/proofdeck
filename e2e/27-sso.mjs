// Single sign-on: admin settings page and the button on the sign-in page, against a tiny fake provider.
import crypto from 'node:crypto';
import http from 'node:http';
import { connect } from './uilib.mjs';

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
let issuer; const pend = new Map();
const idp = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys` });
  if (u.pathname === '/keys') return json({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k', use: 'sig' }] });
  if (u.pathname === '/authorize') {
    const code = crypto.randomBytes(6).toString('hex'); pend.set(code, u.searchParams.get('nonce'));
    const back = new URL(u.searchParams.get('redirect_uri')); back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() }); return res.end();
  }
  if (u.pathname === '/token') { req.on('data', () => {}); return req.on('end', () => {
    const t = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: 'cid', sub: 'u-1', exp: t + 300, iat: t, nonce: [...pend.values()].pop(), email: 'ada@example.com', email_verified: true };
    const h = b64({ alg: 'RS256', kid: 'k' }), p = b64(claims);
    json({ id_token: `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), rsa.privateKey).toString('base64url')}` });
  }); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => idp.listen(0, '127.0.0.1', r));
issuer = `http://127.0.0.1:${idp.address().port}`;

const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
await api('/api/auth/profile', 'PUT', { email: 'ada@example.com' });
const type = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);

await go('#/sso'); await sleep(600);
check('the page shows the redirect address to register', (await text('#sso-redirect')).endsWith('/api/auth/oidc/callback'));
await type('[name=issuer]', issuer);
await click('[data-act=test]'); await sleep(1200);
check('the test button reaches the provider', (await text('#sso-result')).includes('Reachable'), await text('#sso-result'));
await type('[name=clientId]', 'cid'); await type('[name=clientSecret]', 'sec'); await type('[name=label]', 'Test IdP');
await js(`document.querySelector('[name=enabled]').click()`);
await js(`document.querySelector('#sso-form').requestSubmit()`); await sleep(1000);
check('saved and the secret is not shown again', (await text('#view')).includes('Saved. Leave blank') && (await api('/api/settings/oidc')).enabled === true);

// sign out, then use the button
await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(900);
check('the sign-in page offers the button', (await text('#sso-btn')).includes('Sign in with Test IdP'), await text('#auth'));
await js(`document.querySelector('#sso-btn').click()`); await sleep(2500);
const me = await api('/api/auth/me');
check('clicking it signs the linked account in', me.user && me.user.username === 'admin', JSON.stringify(me).slice(0, 120));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404|429)/.test(e)).length === 0, t.errors.join(' | '));
idp.close();
process.exit(t.finish() ? 1 : 0);
