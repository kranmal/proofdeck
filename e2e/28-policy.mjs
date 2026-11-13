// Sign-in policy: "require two-factor for admins" forces set-up before the app loads.
import crypto from 'node:crypto';
import { connect } from './uilib.mjs';
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const unb32 = (t) => { let bits = ''; for (const c of t) bits += A.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
const codeAt = (secret, counter) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(counter)); const h = crypto.createHmac('sha1', unb32(secret)).update(m).digest(); const o = h[19] & 15; return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); };

const t = await connect({ out: process.argv[2] });
const { check, js, sleep, api, go, click, text, send } = t;
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await t.setup();
await go('#/sso'); await sleep(600);
await js(`document.querySelector('#policy-form [name=require2fa]').value = 'admins'`);
await js(`document.querySelector('#policy-form').requestSubmit()`); await sleep(800);
check('the policy is saved (and applies to this admin at once)', (await text('#toast')).includes('Policy saved'), await text('#toast'));
await js(`location.reload()`); await sleep(1500);
check('the next page load shows the forced set-up instead of the app', (await text('#auth')).includes('Set up two-factor sign-in'), await text('#auth'));
await js(`document.querySelector('[data-tf=setup]').click()`); await sleep(600);
const secret = (await text('.secretkey')).replace(/\s/g, '');
await js(`(() => { const e = document.querySelector('[data-tf-code]'); e.value = ${JSON.stringify(codeAt(secret, Math.floor(Date.now() / 30000) - 1))}; })()`);
await js(`document.querySelector('[data-tf=enable]').click()`); await sleep(900);
check('recovery codes are shown', (await text('.recovery')).length > 20);
await js(`document.querySelector('[data-tf=done]').click()`); await sleep(2000);
check('then the app loads', (await js(`!document.querySelector('#auth') || document.querySelector('#auth').hidden`)) && (await api('/api/projects')).length >= 1);
await go('#/users'); await sleep(600);
check('the users list shows a 2FA badge', (await text('tbody')).includes('2FA'));
check('no console errors', t.errors.filter((e) => !/status of (401|403|400|404|429)/.test(e)).length === 0, t.errors.join(' | '));
process.exit(t.finish() ? 1 : 0);
