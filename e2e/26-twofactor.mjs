// Two-factor sign-in: set up in the account dialog, sign in with a code, use a recovery code, admin reset.
import crypto from 'node:crypto';
import { connect } from './uilib.mjs';
// the same RFC 6238 maths the server uses, written out here so the test does not import the code it checks
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const unb32 = (t) => { let bits = ''; for (const c of t) bits += A.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
const codeAt = (secret, counter) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(counter)); const h = crypto.createHmac('sha1', unb32(secret)).update(m).digest(); const o = h[19] & 15; return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); };
const step = () => Math.floor(Date.now() / 30000);

const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, count, submit, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
const signOut = async () => { await click('#me'); await sleep(300); await js(`document.querySelector('[data-signout]').click()`); await sleep(800); };
const type = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);

await click('#me'); await sleep(500);
check('account dialog offers to set up two-factor', (await text('#twofa')).includes('Set up'));
await js(`document.querySelector('[data-tf=setup]').click()`); await sleep(600);
const secret = (await text('.secretkey')).replace(/\s/g, '');
check('a QR code is shown', (await count('#twofa .qr svg path')) === 1);
check('a key is shown to add to the app', /^[A-Z2-7]{32}$/.test(secret), secret);
await type('[data-tf-code]', '000000'); await js(`document.querySelector('[data-tf=enable]').click()`); await sleep(600);
check('a wrong code is refused', (await text('#toast')).includes('not right'), await text('#toast'));
await type('[data-tf-code]', codeAt(secret, step() - 1)); await js(`document.querySelector('[data-tf=enable]').click()`); await sleep(800);
const codes = (await text('.recovery')).split(/\s+/).filter(Boolean);
check('turning it on shows ten recovery codes once', codes.length === 10 && /^[0-9a-f]{6}-[0-9a-f]{6}$/.test(codes[0]), codes.join(','));
await js(`document.querySelector('[data-tf=done]').click()`); await sleep(300);
check('status says it is on', (await text('#twofa')).includes('On'));
await js(`document.querySelector('dialog').close()`);

await signOut();
const login = async () => js(`(() => { const f = document.querySelector('#auth-form'); f.username.value = 'admin'; f.password.value = ${JSON.stringify(process.env.PW || 'correct horse battery')}; f.requestSubmit(); })()`);
await login(); await sleep(1200);
check('after the password, a code is asked for (not signed in yet)', (await text('#auth')).includes('Two-factor code') && !(await api('/api/auth/me')).user);
await type('[name=code]', '111111'); await js(`document.querySelector('#auth-form2').requestSubmit()`); await sleep(800);
check('a wrong code shows an error and stays on the form', (await text('#auth-err')).includes('not right'));
await type('[name=code]', codeAt(secret, step() + 1)); await js(`document.querySelector('#auth-form2').requestSubmit()`); await sleep(1500);
check('a right code signs in', (await js(`!document.querySelector('#auth') || document.querySelector('#auth').hidden`)) && (await api('/api/auth/me')).user?.totp === true);

await signOut();
await login(); await sleep(1200);
await type('[name=code]', codes[0]); await js(`document.querySelector('#auth-form2').requestSubmit()`); await sleep(1500);
check('a recovery code also signs in', (await api('/api/auth/me')).user?.username === 'admin');

check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404|429)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
