'use strict';
// Encrypts integration tokens at rest (AES-256-GCM). The key comes from PROOFDECK_SECRET, or from data/secret.key
// (created with mode 600 on first use). Anyone who can read both the database and the key can read the tokens,
// so keep the data directory private; set PROOFDECK_SECRET to keep the key off the disk entirely.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let key = null;

function init(dataDir) {
  if (process.env.PROOFDECK_SECRET) {
    key = crypto.createHash('sha256').update(process.env.PROOFDECK_SECRET).digest();
    return;
  }
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600 });
  }
  if (key.length !== 32) throw new Error(`${file} is corrupt: expected a base64 encoded 32 byte key`);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

// Returns null when the value cannot be decrypted (wrong key, tampered data).
function decrypt(blob) {
  try {
    const [v, iv, tag, data] = String(blob).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

module.exports = { init, encrypt, decrypt };
