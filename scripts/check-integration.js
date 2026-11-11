#!/usr/bin/env node
'use strict';
// Check a Jira or GitHub connection with your real credentials, using the same code the app uses.
// The token is read from the environment, never from the command line.
//
//   GITHUB_TOKEN=ghp_... npm run check-integration -- github --owner acme --repo shop
//   JIRA_TOKEN=...       npm run check-integration -- jira --base https://team.atlassian.net --email you@co.com --project PROJ
//
// By default only reads (a connection test). Add --create to also file ONE clearly labelled throwaway issue
// (Jira also gets a tiny PNG attachment) so you can see the real result; close or delete it afterwards.

const { github, jira, validateBase, IntegrationError } = require('../lib/integrations');

const [kind, ...rest] = process.argv.slice(2);
const opt = (name, def = '') => { const i = rest.indexOf(`--${name}`); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : def; };
const has = (name) => rest.includes(`--${name}`);
const die = (m) => { console.error(`check-integration: ${m}`); process.exit(1); };

if (!['github', 'jira'].includes(kind)) die('say which one: github or jira (see the comment at the top of this file)');
const token = process.env[kind === 'github' ? 'GITHUB_TOKEN' : 'JIRA_TOKEN'];
if (!token) die(`set ${kind === 'github' ? 'GITHUB_TOKEN' : 'JIRA_TOKEN'} in the environment`);

let cfg;
try {
  cfg = kind === 'github'
    ? { base: validateBase(opt('base', 'https://api.github.com'), 'GitHub API URL'), owner: opt('owner'), repo: opt('repo'), labels: ['bug'] }
    : { base: validateBase(opt('base'), 'Jira site URL'), email: opt('email'), projectKey: opt('project').toUpperCase(), issueType: opt('issue-type', 'Bug'), labels: [] };
} catch (e) { die(e.message); }
if (kind === 'github' && (!cfg.owner || !cfg.repo)) die('--owner and --repo are required');
if (kind === 'jira' && (!cfg.email || !cfg.projectKey)) die('--email and --project are required (and --base)');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sampleBug = {
  id: 0, key: 'CHECK-1', title: 'Proofdeck integration check (safe to close)', status: 'Open', severity: 'Minor', priority: 'Low',
  environment: 'Integration check', case_key: 'CHECK-T1', step_no: 2, cycle_key: 'CHECK-C1',
  steps_to_reproduce: '1. Run npm run check-integration\n2. Look at this issue\n3. Close it',
  expected: 'The issue is created with these sections', actual: 'It was created by Proofdeck. Mention test: @example-user (not a real ping)',
};

(async () => {
  const client = kind === 'github' ? github : jira;
  try {
    console.log(`Testing ${kind}…`);
    console.log('  ✓', await client.test(cfg, token));
    if (!has('create')) { console.log('\nRead-only check passed. Add --create to file one throwaway issue.'); return; }
    const made = await client.createIssue(cfg, token, sampleBug, { bugUrl: '', attachments: kind === 'jira' ? [{ filename: 'check.png', mime: 'image/png', data: PNG }] : [] });
    console.log(`  ✓ created ${made.key}: ${made.url}`);
    if (made.note) console.log(`  note: ${made.note}`);
    console.log('\nLook at the issue, then close or delete it. If it looks right, the integration works end to end.');
  } catch (e) {
    if (e instanceof IntegrationError) die(e.message);
    die(e.stack || e.message);
  }
})();
