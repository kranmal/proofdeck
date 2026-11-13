'use strict';
// Clients for creating issues in GitHub and Jira (Cloud, or Server / Data Center). Pure: they take config + token and return results or throw
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
      headers: { 'User-Agent': 'Proofdeck', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
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
    const detail = data && (data.message || data.error || (data.errorMessages || []).join('; ') || (Array.isArray(data.errors) ? data.errors.map((x) => x && x.message || x).join('; ') : Object.values(data.errors || {}).join('; '))) || text.slice(0, 200) || 'no details';
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

// States are normalised to "open" | "progress" | "done" so Proofdeck does not care how each tracker names them.
const ghNumber = (key) => String(key).replace(/^#/, '');

const github = {
  async getState(cfg, token, key) {
    const r = await gh(cfg, token, 'GET', `/repos/${cfg.owner}/${cfg.repo}/issues/${ghNumber(key)}`);
    return { state: r.state === 'closed' ? 'done' : 'open', label: r.state === 'closed' && r.state_reason ? `closed (${r.state_reason})` : r.state };
  },
  async setState(cfg, token, key, want) {
    const done = want === 'done';
    await gh(cfg, token, 'PATCH', `/repos/${cfg.owner}/${cfg.repo}/issues/${ghNumber(key)}`, done ? { state: 'closed', state_reason: 'completed' } : { state: 'open' });
    return { state: done ? 'done' : 'open', label: done ? 'closed (completed)' : 'open' };
  },
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

// ---------- Jira ----------
// Cloud: REST v3, email + API token (Basic), descriptions in Atlassian Document Format.
// Server / Data Center: REST v2, a personal access token (Bearer), descriptions in Jira wiki markup.
const isServer = (cfg) => cfg.variant === 'server';
const jiraAuth = (cfg, token) => ({ Authorization: isServer(cfg) ? `Bearer ${token}` : `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}`, Accept: 'application/json' });
const jr = (cfg, token, method, path, opts = {}) => call('Jira', cfg.base, token, method, path.replace('/rest/api/3/', isServer(cfg) ? '/rest/api/2/' : '/rest/api/3/'), { ...opts, headers: { ...jiraAuth(cfg, token), ...(opts.headers || {}) } });

// Wiki markup: escape the characters that start macros, links and formatting so test data cannot restyle the issue.
const wikiText = (t) => String(t || '').replace(/([\\{}\[\]|])/g, '\\$1').replace(/^([*#\-+h]\S*[.]?)(?=\s)/gm, (m) => `\\${m}`);
function jiraWiki(bug, bugUrl) {
  const out = [wikiText([`Severity: ${bug.severity}`, `Priority: ${bug.priority}`, `Status: ${bug.status}`, bug.environment && `Environment: ${bug.environment}`,
    bug.case_key && `Found by: ${bug.case_key} step ${bug.step_no} (${bug.cycle_key})`].filter(Boolean).join(' | '))];
  if (bugUrl) out.push(`Proofdeck: [${wikiText(bug.key)}|${bugUrl.replace(/[|\]\s]/g, encodeURIComponent)}]`);
  for (const [h, t] of [['Steps to reproduce', bug.steps_to_reproduce], ['Expected result', bug.expected], ['Actual result', bug.actual]]) {
    if (String(t || '').trim()) out.push(`h3. ${h}`, ...String(t).split(/\r?\n/).filter((l) => l.trim()).map(wikiText));
  }
  return out.join('\n\n');
}

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
  async getState(cfg, token, key) {
    const r = await jr(cfg, token, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`);
    const st = (r.fields && r.fields.status) || {};
    const cat = st.statusCategory && st.statusCategory.key;
    return { state: cat === 'done' ? 'done' : cat === 'indeterminate' ? 'progress' : 'open', label: st.name || cat || 'unknown' };
  },
  // Jira moves issues with workflow transitions: pick one that lands in the wanted status category.
  async setState(cfg, token, key, want) {
    const t = await jr(cfg, token, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    const cats = want === 'done' ? ['done'] : want === 'progress' ? ['indeterminate'] : ['new', 'indeterminate'];
    let list = [];
    for (const c of cats) { list = (t.transitions || []).filter((x) => x.to && x.to.statusCategory && x.to.statusCategory.key === c); if (list.length) break; }
    if (!list.length) throw new IntegrationError(`${key} has no workflow transition to a “${cats[0]}” status from its current status`);
    const pick = list.find((x) => /done|resolve|close|reopen|re-open|to do|open/i.test(x.name)) || list[0];
    await jr(cfg, token, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { json: { transition: { id: pick.id } } });
    return { state: want, label: (pick.to && pick.to.name) || pick.name };
  },
  async test(cfg, token) {
    const me = await jr(cfg, token, 'GET', '/rest/api/3/myself');
    const p = await jr(cfg, token, 'GET', `/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}`);
    return `Connected as ${me.displayName || me.name || cfg.email} · project ${p.key} (${p.name})${isServer(cfg) ? ' · Server / Data Center' : ''}`;
  },
  async createIssue(cfg, token, bug, { bugUrl, attachments }) {
    const labels = [...new Set(['proofdeck', `severity-${String(bug.severity).toLowerCase()}`, ...(cfg.labels || [])].map((l) => l.replace(/\s+/g, '-')))];
    const r = await jr(cfg, token, 'POST', '/rest/api/3/issue', {
      json: { fields: { project: { key: cfg.projectKey }, issuetype: { name: cfg.issueType || 'Bug' }, summary: bug.title.replace(/\s+/g, ' ').slice(0, 255), description: isServer(cfg) ? jiraWiki(bug, bugUrl) : jiraDescription(bug, bugUrl), labels } },
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

// ---------- Linear ----------
// GraphQL. A personal API key goes in the Authorization header as it is (OAuth tokens use Bearer).
const lin = async (cfg, token, query, variables) => {
  const r = await call('Linear', cfg.base, token, 'POST', '/graphql', {
    json: { query, variables }, headers: { Authorization: /^lin_oauth_/.test(token) ? `Bearer ${token}` : token },
  });
  if (r && r.errors && r.errors.length) throw new IntegrationError(`Linear said: ${r.errors.map((e) => e.message).join('; ').replace(token, '***').slice(0, 300)}`);
  return r.data;
};
const linTeam = async (cfg, token) => {
  const d = await lin(cfg, token, 'query($key:String!){ teams(filter:{key:{eq:$key}}){ nodes{ id name key } } }', { key: cfg.teamKey });
  const t = d.teams.nodes[0];
  if (!t) throw new IntegrationError(`Linear has no team with the key ${cfg.teamKey}`);
  return t;
};
const LINEAR_PRIORITY = { Critical: 1, Major: 2, Minor: 3, Trivial: 4 }; // Urgent, High, Medium, Low

const linear = {
  async getState(cfg, token, key) {
    const d = await lin(cfg, token, 'query($id:String!){ issue(id:$id){ state{ name type } } }', { id: key });
    const st = d.issue && d.issue.state;
    if (!st) throw new IntegrationError(`Linear has no issue ${key}`);
    return { state: ['completed', 'canceled'].includes(st.type) ? 'done' : st.type === 'started' ? 'progress' : 'open', label: st.name };
  },
  async setState(cfg, token, key, want) {
    const d = await lin(cfg, token, 'query($id:String!){ issue(id:$id){ id team{ states{ nodes{ id name type } } } } }', { id: key });
    if (!d.issue) throw new IntegrationError(`Linear has no issue ${key}`);
    const states = d.issue.team.states.nodes;
    const order = want === 'done' ? ['completed'] : want === 'progress' ? ['started'] : ['unstarted', 'backlog'];
    let pick;
    for (const type of order) { pick = states.find((s) => s.type === type); if (pick) break; }
    if (!pick) throw new IntegrationError(`The Linear team has no “${order[0]}” workflow state for ${key}`);
    await lin(cfg, token, 'mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){ success } }', { id: d.issue.id, input: { stateId: pick.id } });
    return { state: want, label: pick.name };
  },
  async test(cfg, token) {
    const d = await lin(cfg, token, 'query{ viewer{ name email } }');
    const team = await linTeam(cfg, token);
    return `Connected as ${d.viewer.name || d.viewer.email} · team ${team.key} (${team.name})`;
  },
  async createIssue(cfg, token, bug, { bugUrl, attachments }) {
    const team = await linTeam(cfg, token);
    // Linear hosts uploads: ask for a signed address, PUT the bytes there, then embed the asset address as an image.
    let embeds = '', failed = 0;
    for (const a of attachments.slice(0, MAX_ATTACHMENTS)) {
      try {
        const d = await lin(cfg, token, 'mutation($t:String!,$f:String!,$s:Int!){ fileUpload(contentType:$t, filename:$f, size:$s){ success uploadFile{ uploadUrl assetUrl headers{ key value } } } }',
          { t: a.mime, f: a.filename, s: a.data.length });
        const f = d.fileUpload && d.fileUpload.success && d.fileUpload.uploadFile;
        if (!f) throw new Error('no upload address');
        const headers = { 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000' };
        for (const h of f.headers || []) headers[h.key] = h.value;
        const put = await fetch(f.uploadUrl, { method: 'PUT', headers, body: a.data, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
        if (!put.ok) throw new Error(`upload answered ${put.status}`);
        embeds += `\n![${a.filename.replace(/[\[\]]/g, '')}](${f.assetUrl})`;
      } catch { failed++; }
    }
    const skipped = Math.max(0, attachments.length - MAX_ATTACHMENTS);
    const description = (githubBody(bug, { bugUrl, screenshots: 0 }) + (embeds ? `\n### Screenshots${embeds}\n` : '')).slice(0, 60000);
    const d = await lin(cfg, token, 'mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url } } }', {
      input: { teamId: team.id, title: bug.title.replace(/\s+/g, ' ').slice(0, 250), description, priority: LINEAR_PRIORITY[bug.severity] || 0 },
    });
    if (!d.issueCreate || !d.issueCreate.success) throw new IntegrationError('Linear did not create the issue');
    return { key: d.issueCreate.issue.identifier, url: d.issueCreate.issue.url, note: failed || skipped ? `${failed + skipped} of ${attachments.length} screenshot${attachments.length === 1 ? '' : 's'} could not be uploaded.` : '' };
  },
};

// ---------- Azure DevOps ----------
// base is https://dev.azure.com/<organisation> (or an Azure DevOps Server collection URL); a personal access token goes in Basic auth.
const ado = (cfg, token, method, path, opts = {}) => call('Azure DevOps', cfg.base, token, method, path, {
  ...opts, headers: { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`, Accept: 'application/json', ...(opts.headers || {}) },
});
const ADO_API = 'api-version=7.1';
const escHtml = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const htmlLines = (t) => escHtml(String(t || '').trim()).replace(/\r?\n/g, '<br>');
function adoHtml(bug, bugUrl) {
  const sec = (h, t) => (String(t || '').trim() ? `<h3>${h}</h3><p>${htmlLines(t)}</p>` : '');
  return `<p><b>Severity:</b> ${escHtml(bug.severity)} · <b>Priority:</b> ${escHtml(bug.priority)} · <b>Status:</b> ${escHtml(bug.status)}</p>`
    + (bug.environment ? `<p><b>Environment:</b> ${escHtml(bug.environment)}</p>` : '')
    + (bug.case_key ? `<p><b>Found by:</b> ${escHtml(bug.case_key)} step ${bug.step_no} (${escHtml(bug.cycle_key)})</p>` : '')
    + `<p><b>Proofdeck:</b> ${bugUrl ? `<a href="${escHtml(bugUrl)}">${escHtml(bug.key)}</a>` : escHtml(bug.key)}</p>`
    + sec('Steps to reproduce', bug.steps_to_reproduce) + sec('Expected result', bug.expected) + sec('Actual result', bug.actual);
}
const adoType = (cfg) => encodeURIComponent(cfg.workItemType || 'Bug');
const ADO_PRIORITY = { Critical: 1, Major: 2, Minor: 3, Trivial: 4 };
const azure = {
  async getState(cfg, token, key) {
    const w = await ado(cfg, token, 'GET', `/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${encodeURIComponent(key)}?fields=System.State,System.WorkItemType&${ADO_API}`);
    const name = w.fields['System.State'], type = encodeURIComponent(w.fields['System.WorkItemType'] || cfg.workItemType || 'Bug');
    const states = await ado(cfg, token, 'GET', `/${encodeURIComponent(cfg.project)}/_apis/wit/workitemtypes/${type}/states?${ADO_API}`);
    const cat = ((states.value || []).find((s) => s.name === name) || {}).category;
    return { state: ['Completed', 'Resolved', 'Removed'].includes(cat) ? 'done' : cat === 'InProgress' ? 'progress' : 'open', label: name };
  },
  async setState(cfg, token, key, want) {
    const w = await ado(cfg, token, 'GET', `/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${encodeURIComponent(key)}?fields=System.WorkItemType&${ADO_API}`);
    const type = encodeURIComponent(w.fields['System.WorkItemType'] || cfg.workItemType || 'Bug');
    const states = (await ado(cfg, token, 'GET', `/${encodeURIComponent(cfg.project)}/_apis/wit/workitemtypes/${type}/states?${ADO_API}`)).value || [];
    const order = want === 'done' ? ['Completed', 'Resolved'] : want === 'progress' ? ['InProgress'] : ['Proposed'];
    let pick;
    for (const c of order) { pick = states.find((s) => s.category === c); if (pick) break; }
    if (!pick) throw new IntegrationError(`${key} has no “${order[0]}” state in its workflow`);
    await ado(cfg, token, 'PATCH', `/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/${encodeURIComponent(key)}?${ADO_API}`, {
      json: [{ op: 'add', path: '/fields/System.State', value: pick.name }], headers: { 'Content-Type': 'application/json-patch+json' },
    });
    return { state: want, label: pick.name };
  },
  async test(cfg, token) {
    const p = await ado(cfg, token, 'GET', `/_apis/projects/${encodeURIComponent(cfg.project)}?${ADO_API}`);
    return `Connected to project ${p.name}`;
  },
  async createIssue(cfg, token, bug, { bugUrl, attachments }) {
    const type = cfg.workItemType || 'Bug';
    const descField = type === 'Bug' ? 'Microsoft.VSTS.TCM.ReproSteps' : 'System.Description';
    const ops = [
      { op: 'add', path: '/fields/System.Title', value: bug.title.replace(/\s+/g, ' ').slice(0, 250) },
      { op: 'add', path: `/fields/${descField}`, value: adoHtml(bug, bugUrl) },
      { op: 'add', path: '/fields/System.Tags', value: ['proofdeck', `severity-${String(bug.severity).toLowerCase()}`, ...(cfg.labels || [])].join('; ') },
    ];
    if (type === 'Bug') ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: ADO_PRIORITY[bug.severity] || 3 });
    let failed = 0;
    for (const a of attachments.slice(0, MAX_ATTACHMENTS)) {
      try {
        const up = await ado(cfg, token, 'POST', `/${encodeURIComponent(cfg.project)}/_apis/wit/attachments?fileName=${encodeURIComponent(a.filename)}&${ADO_API}`, { form: a.data, headers: { 'Content-Type': 'application/octet-stream' } });
        ops.push({ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: up.url, attributes: { comment: 'From Proofdeck' } } });
      } catch { failed++; }
    }
    const w = await ado(cfg, token, 'POST', `/${encodeURIComponent(cfg.project)}/_apis/wit/workitems/$${adoType(cfg)}?${ADO_API}`, { json: ops, headers: { 'Content-Type': 'application/json-patch+json' } });
    const skipped = Math.max(0, attachments.length - MAX_ATTACHMENTS);
    return { key: String(w.id), url: (w._links && w._links.html && w._links.html.href) || `${cfg.base}/${encodeURIComponent(cfg.project)}/_workitems/edit/${w.id}`,
      note: failed || skipped ? `${failed + skipped} of ${attachments.length} screenshot${attachments.length === 1 ? '' : 's'} could not be attached.` : '' };
  },
};

// ---------- GitLab ----------
const gl = (cfg, token, method, path, opts = {}) => call('GitLab', cfg.base, token, method, `/api/v4${path}`, { ...opts, headers: { 'PRIVATE-TOKEN': token, ...(opts.headers || {}) } });
const glProject = (cfg) => `/projects/${encodeURIComponent(cfg.project)}`;
const gitlab = {
  async getState(cfg, token, key) {
    const r = await gl(cfg, token, 'GET', `${glProject(cfg)}/issues/${ghNumber(key)}`);
    return { state: r.state === 'closed' ? 'done' : 'open', label: r.state };
  },
  async setState(cfg, token, key, want) {
    const done = want === 'done';
    await gl(cfg, token, 'PUT', `${glProject(cfg)}/issues/${ghNumber(key)}`, { json: { state_event: done ? 'close' : 'reopen' } });
    return { state: done ? 'done' : 'open', label: done ? 'closed' : 'opened' };
  },
  async test(cfg, token) {
    const r = await gl(cfg, token, 'GET', glProject(cfg));
    return `Connected to ${r.path_with_namespace || cfg.project}`;
  },
  async createIssue(cfg, token, bug, { bugUrl, attachments }) {
    // GitLab can host uploads, so screenshots are embedded in the description as images.
    let embeds = '', failed = 0;
    for (const a of attachments.slice(0, MAX_ATTACHMENTS)) {
      try {
        const form = new FormData();
        form.append('file', new Blob([a.data], { type: a.mime }), a.filename);
        const up = await gl(cfg, token, 'POST', `${glProject(cfg)}/uploads`, { form });
        if (up && up.markdown) embeds += `\n${up.markdown}`;
      } catch { failed++; }
    }
    const description = (githubBody(bug, { bugUrl, screenshots: 0 }) + (embeds ? `\n### Screenshots${embeds}\n` : '')).slice(0, 1000000);
    const labels = [...new Set([...(cfg.labels || []), `severity::${String(bug.severity).toLowerCase()}`])].join(',');
    const r = await gl(cfg, token, 'POST', `${glProject(cfg)}/issues`, { json: { title: defang(bug.title).slice(0, 250), description, labels } });
    const skipped = Math.max(0, attachments.length - MAX_ATTACHMENTS);
    return { key: `#${r.iid}`, url: r.web_url, note: failed || skipped ? `${failed + skipped} of ${attachments.length} screenshot${attachments.length === 1 ? '' : 's'} could not be uploaded.` : '' };
  },
};

module.exports = { call, IntegrationError, validateBase, github, jira, linear, azure, gitlab, jiraWiki };
