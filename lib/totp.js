'use strict';
// Time-based one-time passwords (RFC 6238) for authenticator apps: HMAC-SHA1, 30 second steps, 6 digits.

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function unbase32(text) {
  let bits = '';
  for (const c of String(text).toUpperCase().replace(/[\s=-]/g, '')) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('not base32');
    bits += i.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const newSecret = () => base32(crypto.randomBytes(20));

function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

// Accepts the previous, current and next step (clock drift). Returns the matching step number, or null.
// A step at or below `lastStep` is refused so a code cannot be used twice.
function verify(secret, code, { lastStep = 0, at = Date.now() } = {}) {
  const c = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = Math.floor(at / 1000 / STEP);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= lastStep) continue;
    const want = Buffer.from(codeAt(secret, step)), got = Buffer.from(c);
    if (crypto.timingSafeEqual(want, got)) return step;
  }
  return null;
}

const uri = (secret, account, issuer = 'Proofdeck') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

module.exports = { newSecret, codeAt, verify, uri, STEP };
