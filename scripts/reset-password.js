#!/usr/bin/env node
'use strict';
// Reset a Proofdeck user's password from the server's command line (for a locked-out admin).
//
//   npm run reset-password -- --list
//   npm run reset-password -- ada                  # prompts for the new password (hidden)
//   npm run reset-password -- ada --make-admin --activate
//   npm run reset-password -- ada --clear-2fa      # also switch off their two-factor sign-in
//   echo 'new password here' | npm run reset-password -- ada --password-stdin
//
// Works while the server is running. Uses DATA_DIR like the server does (default ./data).
// All of the user's sessions are ended.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const auth = require('../lib/auth');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const username = args.find((a) => !a.startsWith('--'));
const fail = (msg) => { console.error(`reset-password: ${msg}`); process.exit(1); };

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'proofdeck.db');
if (!fs.existsSync(dbFile)) fail(`no database at ${dbFile}. Set DATA_DIR if your data lives elsewhere.`);
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA busy_timeout = 5000');
const hasUsers = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
if (!hasUsers) fail('this database has no users table yet. Start Proofdeck once, then try again.');

function readLine(stream) {
  return new Promise((resolve) => { let buf = ''; stream.setEncoding('utf8'); stream.on('data', (d) => { buf += d; }); stream.on('end', () => resolve(buf.split(/\r?\n/)[0])); });
}

// Reads a line from the terminal without echoing it.
function askHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let text = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(text); }
        if (c === '\u007f' || c === '\b') text = text.slice(0, -1); else text += c;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const users = db.prepare('SELECT id, username, display_name, role, active FROM users ORDER BY id').all();
  if (flag('--list')) {
    if (!users.length) console.log('No users yet. Open Proofdeck in a browser to create the first admin.');
    for (const u of users) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(7)} ${u.active ? 'active' : 'INACTIVE'}  ${u.display_name}`);
    return;
  }
  if (!users.length) fail('there are no users yet. Open Proofdeck in a browser to create the first admin.');
  const target = username ? db.prepare('SELECT * FROM users WHERE username=?').get(username) : users.length === 1 ? db.prepare('SELECT * FROM users WHERE id=?').get(users[0].id) : null;
  if (!target) fail(username ? `no user named “${username}”. Users: ${users.map((u) => u.username).join(', ')}` : `say which user: ${users.map((u) => u.username).join(', ')}`);

  const interactive = process.stdin.isTTY && !flag('--password-stdin');
  let password;
  if (interactive) {
    password = await askHidden(`New password for ${target.username}: `);
    if ((await askHidden('Repeat it: ')) !== password) fail('the two passwords differ. Nothing was changed.');
  } else password = await readLine(process.stdin);
  const bad = auth.checkPassword(password, target.username);
  if (bad) fail(`${bad}. Nothing was changed.`);

  const hash = await auth.hashPassword(password);
  db.exec('BEGIN');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, target.id);
  if (flag('--make-admin')) db.prepare("UPDATE users SET role='admin' WHERE id=?").run(target.id);
  if (flag('--clear-2fa')) db.prepare("UPDATE users SET totp_enabled=0, totp_secret='', totp_last_step=0, recovery_codes='[]' WHERE id=?").run(target.id);
  if (flag('--activate')) db.prepare('UPDATE users SET active=1 WHERE id=?').run(target.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
  db.exec('COMMIT');
  console.log(`Password changed for ${target.username}${flag('--make-admin') ? ' (now an admin)' : ''}${flag('--activate') ? ' (account re-activated)' : ''}${flag('--clear-2fa') ? ' (two-factor sign-in switched off)' : ''}. Their sessions were ended.`);
  if (!target.active && !flag('--activate')) console.log('Note: this account is inactive and still cannot sign in. Add --activate to enable it.');
})().catch((e) => fail(e.message));
