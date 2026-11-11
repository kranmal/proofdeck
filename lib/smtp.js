'use strict';
// A small SMTP client (no dependencies): implicit TLS, STARTTLS or plain, AUTH PLAIN/LOGIN, one message per call.
// It refuses to send a password over an unencrypted connection unless the server is on this machine.

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');

class SmtpError extends Error {}
const TIMEOUT_MS = 20000;
const isLoopback = (h) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(h).toLowerCase());
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@<>"(),;:\\]+@[^\s@<>"(),;:\\]+\.[^\s@<>"(),;:\\]+$/.test(e);

// RFC 2047 encoded-words for non-ASCII header text, in chunks that never split a character.
function encodeWord(s) {
  const text = oneLine(s);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const chars = Array.from(text), parts = [];
  for (let i = 0; i < chars.length; i += 16) parts.push(`=?UTF-8?B?${Buffer.from(chars.slice(i, i + 16).join(''), 'utf8').toString('base64')}?=`);
  return parts.join('\r\n ');
}
const phrase = (name) => (/^[A-Za-z0-9 ._-]*$/.test(name) ? `"${name}"` : encodeWord(name));

function buildMessage({ from, fromName, to, subject, text, domain }) {
  if (!validEmail(from) || !validEmail(to)) throw new SmtpError('Invalid sender or recipient address');
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `Date: ${new Date().toUTCString()}`,
    `From: ${oneLine(fromName) ? `${phrase(oneLine(fromName))} <${from}>` : from}`,
    `To: <${to}>`,
    `Subject: ${encodeWord(subject)}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${oneLine(domain) || 'proofdeck.local'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '', body, '',
  ].join('\r\n');
}

// Reads SMTP replies (possibly several lines, "250-" continuations) one at a time.
function reader(socket) {
  let buf = '', pending = null, failure = null;
  const settle = () => {
    if (!pending) return;
    if (failure) { const p = pending; pending = null; clearTimeout(p.timer); return p.reject(failure); }
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3}( |$)/.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        buf = lines.slice(i + 1).join('\r\n');
        const p = pending; pending = null; clearTimeout(p.timer);
        return p.resolve({ code: Number(reply[0].slice(0, 3)), lines: reply.map((l) => l.slice(4)) });
      }
    }
  };
  socket.on('data', (d) => { buf += d.toString('utf8'); settle(); });
  socket.on('error', (e) => { failure = new SmtpError(`Connection problem: ${e.message}`); settle(); });
  socket.on('close', () => { failure = failure || new SmtpError('The server closed the connection'); settle(); });
  return {
    detach: () => socket.removeAllListeners('data'),
    read: () => new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: setTimeout(() => { pending = null; reject(new SmtpError('The server did not answer in time')); }, TIMEOUT_MS) };
      settle();
    }),
  };
}

// cfg: { host, port, security: 'none' | 'starttls' | 'tls', user, pass, tlsVerify }   msg: { from, fromName, to, subject, text }
async function sendMail(cfg, msg) {
  const host = String(cfg.host), port = Number(cfg.port);
  const security = cfg.security || 'none';
  const tlsOpts = { host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: cfg.tlsVerify !== false };
  const message = buildMessage({ ...msg, domain: msg.from.split('@')[1] });

  let socket = await new Promise((resolve, reject) => {
    const s = security === 'tls' ? tls.connect(tlsOpts) : net.connect({ host, port });
    const timer = setTimeout(() => { s.destroy(); reject(new SmtpError(`Could not connect to ${host}:${port} in time`)); }, TIMEOUT_MS);
    s.once(security === 'tls' ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(s); });
    s.once('error', (e) => { clearTimeout(timer); reject(new SmtpError(`Could not connect to ${host}:${port}: ${e.code || e.message}`)); });
  });
  let rd = reader(socket);
  const say = (line) => socket.write(`${line}\r\n`);
  const expect = async (codes, step) => {
    const r = await rd.read();
    if (!codes.includes(r.code)) throw new SmtpError(`${step}: the server said ${r.code} ${oneLine(r.lines[0]).slice(0, 200)}`);
    return r;
  };
  const ehloName = oneLine(os.hostname()) || 'localhost';
  try {
    await expect([220], 'Greeting');
    say(`EHLO ${ehloName}`);
    let ehlo = await expect([250], 'EHLO');
    let secure = security === 'tls';
    if (security === 'starttls') {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new SmtpError('The server does not offer STARTTLS. Choose another security setting.');
      say('STARTTLS');
      await expect([220], 'STARTTLS');
      rd.detach();
      socket = tls.connect({ ...tlsOpts, socket });
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', (e) => reject(new SmtpError(`TLS failed: ${e.code || e.message}`))); });
      rd = reader(socket);
      secure = true;
      say(`EHLO ${ehloName}`);
      ehlo = await expect([250], 'EHLO');
    }
    if (cfg.user) {
      if (!secure && !isLoopback(host)) throw new SmtpError('Refusing to send the password over an unencrypted connection. Use STARTTLS or TLS.');
      const mechs = ehlo.lines.map((l) => /^AUTH\s+(.*)$/i.exec(l)).filter(Boolean).flatMap((m) => m[1].toUpperCase().split(/\s+/));
      const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
      if (mechs.includes('PLAIN')) { say(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass || ''}`)}`); await expect([235], 'Sign-in'); }
      else if (mechs.includes('LOGIN')) {
        say('AUTH LOGIN'); await expect([334], 'Sign-in');
        say(b64(cfg.user)); await expect([334], 'Sign-in');
        say(b64(cfg.pass || '')); await expect([235], 'Sign-in');
      } else throw new SmtpError('The server offers no sign-in method Proofdeck supports (PLAIN or LOGIN).');
    }
    say(`MAIL FROM:<${msg.from}>`); await expect([250], 'Sender');
    say(`RCPT TO:<${msg.to}>`); await expect([250, 251], 'Recipient');
    say('DATA'); await expect([354], 'DATA');
    socket.write(`${message.replace(/^\./gm, '..')}\r\n.\r\n`);
    await expect([250], 'Message');
    say('QUIT');
    await expect([221], 'Goodbye').catch(() => {}); // the message is already accepted; just let the server close politely
    return { ok: true };
  } finally { socket.destroy(); }
}

module.exports = { sendMail, buildMessage, validEmail, SmtpError, isLoopback };
