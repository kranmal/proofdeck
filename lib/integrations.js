'use strict';
// Clients for creating issues in GitHub and Jira Cloud. Pure: they take config + token and return results or throw
// IntegrationError. Tokens never appear in messages.

class IntegrationError extends Error {}

const TIMEOUT_MS = 20000;
const MAX_ATTACHMENTS = 10;

// https only, except loopback (handy for local mocks). No credentials in the URL, no query or fragment.
function validateBase(value, label) {
  let u;
  try { u = new URL(String(value).trim()); } catch { throw new IntegrationError(`${label} must be a full URL such as https://example.com`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new IntegrationError(`${label} must start with https://`);
  if (u.username || u.password) throw new IntegrationError(`${label} must not contain a username or password`);
  if (u.search || u.hash) throw new IntegrationError(`${label} must not contain a query or fragment`);
  return u.origin + u.pathname.replace(/\/+$/, '');
}

async function call(service, base, token, method, path, { headers = {}, json, form } = {}) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { 'User-Agent': 'Proofdeck', ...headers, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: json !== undefined ? JSON.stringify(json) : form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'timed out' : /redirect/i.test(String(e.cause || e.message)) ? 'redirected (check the URL, owner and repository)' : 'could not be reached';
    throw new IntegrationError(`${service} ${why}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = data && (data.message || (data.errorMessages || []).join('; ') || Object.values(data.errors || {}).join('; ')) || text.slice(0, 200) || 'no details';
    const hint = res.status === 401 || res.status === 403 ? ' Check the token and its permissions.' : '';
    throw new IntegrationError(`${service} said: ${String(detail).replace(token, '***').slice(0, 300)} (HTTP ${res.status}).${hint}`);
  }
  return data;
}

// Stops @names in test data from pinging real people when the text lands in a GitHub issue.
const defang = (t) => String(t || '').replace(/@(?=[A-Za-z0-9])/g, '@​');

// ---------- GitHub ----------
const gh = (cfg, token, method, path, json) => call('GitHub', cfg.base, token, method, path, {
  json, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
});

function githubBody(bug, { bugUrl, screenshots }) {
  const section = (h, t) => (t && String(t).trim() ? `\n### ${h}\n${defang(String(t).trim())}\n` : '');
  const out = [`**Severity:** ${bug.severity} · **Priority:** ${bug.priority} · **Status:** ${bug.status}`];
  if (bug.environment) out.push(`**Environment:** ${defang(bug.environment)}`);
  if (bug.case_key) out.push(`**Found by:** ${bug.case_key} step ${bug.step_no} (${bug.cycle_key})`);
  out.push(bugUrl ? `**Proofdeck:** [${bug.key}](${bugUrl})` : `**Proofdeck:** ${bug.key}`);
  let body = out.join('\n') + '\n' + section('Steps to reproduce', bug.steps_to_reproduce) + section('Expected result', bug.expected) + section('Actual result', bug.actual);
  if (screenshots) body += `\n### Screenshots\n${screenshots} screenshot${screenshots === 1 ? '' : 's'} ${screenshots === 1 ? 'is' : 'are'} attached to ${bug.key} in Proofdeck (GitHub's API cannot upload images).\n`;
  return body.slice(0, 60000);
}

const github = {
  async test(cfg, token) {
    const r = await gh(cfg, token, 'GET', `/repos/${cfg.owner}/${cfg.repo}`);
    return `Connected to ${r.full_name || `${cfg.owner}/${cfg.repo}`}`;
  },
  async createIssue(cfg, token, bug, { bugUrl, attachments }) {
    const labels = [...new Set([...(cfg.labels || []), `severity: ${String(bug.severity).toLowerCase()}`])];
    const r = await gh(cfg, token, 'POST', `/repos/${cfg.owner}/${cfg.repo}/issues`, {
      title: defang(bug.title).slice(0, 250), body: githubBody(bug, { bugUrl, screenshots: attachments.length }), labels,
    });
    return { key: `#${r.number}`, url: r.html_url, note: attachments.length ? 'Screenshots stay in Proofdeck: GitHub’s API cannot upload images.' : '' };
  },
};

// ---------- Jira Cloud ----------
const jiraAuth = (cfg, token) => ({ Authorization: `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}`, Accept: 'application/json' });
const jr = (cfg, token, method, path, opts = {}) => call('Jira', cfg.base, token, method, path, { ...opts, headers: { ...jiraAuth(cfg, token), ...(opts.headers || {}) } });

// Atlassian Document Format. Text nodes must be non-empty, so empty values are skipped.
const adfText = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
function adfLines(value) {
  const nodes = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    if (line.trim()) nodes.push({ type: 'paragraph', content: [adfText(line)] });
  }
  return nodes;
}
function jiraDescription(bug, bugUrl) {
  const content = [];
  const heading = (t) => content.push({ type: 'heading', attrs: { level: 3 }, content: [adfText(t)] });
  const facts = [`Severity: ${bug.severity}`, `Priority: ${bug.priority}`, `Status: ${bug.status}`];
  if (bug.environment) facts.push(`Environment: ${bug.environment}`);
  if (bug.case_key) facts.push(`Found by: ${bug.case_key} step ${bug.step_no} (${bug.cycle_key})`);
  content.push({ type: 'paragraph', content: [adfText(facts.join(' | '))] });
  if (bugUrl) content.push({ type: 'paragraph', content: [adfText('Proofdeck: '), adfText(bug.key, [{ type: 'link', attrs: { href: bugUrl } }])] });
  for (const [h, t] of [['Steps to reproduce', bug.steps_to_reproduce], ['Expected result', bug.expected], ['Actual result', bug.actual]]) {
    const lines = adfLines(t);
    if (lines.length) { heading(h); content.push(...lines); }
  }
  return { type: 'doc', version: 1, content };
}

const jira = {
  async test(cfg, token) {
    const me = await jr(cfg, token, 'GET', '/rest/api/3/myself');
    const p = await jr(cfg, token, 'GET', `/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}`);
    return `Connected as ${me.displayName || cfg.email} · project ${p.key} (${p.name})`;
  },
  async createIssue(cfg, token, bug, { bugUrl, attachments }) {
    const labels = [...new Set(['proofdeck', `severity-${String(bug.severity).toLowerCase()}`, ...(cfg.labels || [])].map((l) => l.replace(/\s+/g, '-')))];
    const r = await jr(cfg, token, 'POST', '/rest/api/3/issue', {
      json: { fields: { project: { key: cfg.projectKey }, issuetype: { name: cfg.issueType || 'Bug' }, summary: bug.title.replace(/\s+/g, ' ').slice(0, 255), description: jiraDescription(bug, bugUrl), labels } },
    });
    let failed = 0;
    for (const a of attachments.slice(0, MAX_ATTACHMENTS)) {
      try {
        const form = new FormData();
        form.append('file', new Blob([a.data], { type: a.mime }), a.filename);
        await jr(cfg, token, 'POST', `/rest/api/3/issue/${encodeURIComponent(r.key)}/attachments`, { form, headers: { 'X-Atlassian-Token': 'no-check' } });
      } catch { failed++; }
    }
    const skipped = Math.max(0, attachments.length - MAX_ATTACHMENTS);
    return {
      key: r.key, url: `${cfg.base}/browse/${r.key}`,
      note: failed || skipped ? `${failed + skipped} of ${attachments.length} screenshot${attachments.length === 1 ? '' : 's'} could not be attached.` : '',
    };
  },
};

module.exports = { IntegrationError, validateBase, github, jira };
