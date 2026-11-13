'use strict';
// Password hashing (scrypt), cookie helpers and a small in-memory login throttle. No database access here.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const COST = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

const COOKIE = 'pd_session';
const SESSION_DAYS = 14;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { ...COST, maxmem: MAXMEM });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: MAXMEM });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Verifying against this when the user does not exist keeps response time the same either way.
let dummy;
const dummyHash = () => (dummy ||= hashPassword(crypto.randomBytes(12).toString('hex')));

function checkPassword(password, username = '') {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (password.length > MAX_PASSWORD) return `Password must be at most ${MAX_PASSWORD} characters`;
  if (username && password.toLowerCase() === username.toLowerCase()) return 'Password must not be the same as the username';
  return '';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ } }
  }
  return out;
}

const secureCookies = (req) => process.env.COOKIE_SECURE === '1'
  || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');

function sessionCookie(req, token) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secureCookies(req) ? '; Secure' : ''}`;
}
const clearCookie = (req) => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies(req) ? '; Secure' : ''}`;

// Five wrong passwords in a row lock that user+address for 30s, doubling each further failure (max 15 min).
class Limiter {
  constructor() { this.map = new Map(); }
  blocked(key) {
    const e = this.map.get(key);
    return e && e.until > Date.now() ? Math.ceil((e.until - Date.now()) / 1000) : 0;
  }
  fail(key) {
    if (this.map.size > 5000) for (const [k, v] of this.map) if (v.until < Date.now()) this.map.delete(k);
    const e = this.map.get(key) || { fails: 0, until: 0 };
    e.fails++;
    if (e.fails >= 5) e.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (e.fails - 5)) * 1000;
    this.map.set(key, e);
  }
  ok(key) { this.map.delete(key); }
}

module.exports = { secureCookies, hashPassword, verifyPassword, dummyHash, checkPassword, parseCookies, sessionCookie, clearCookie, Limiter, COOKIE, SESSION_DAYS, MAX_PASSWORD };
