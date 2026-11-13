'use strict';
// Pull test cases straight from Zephyr Scale (SmartBear's Cloud API v2, or the Jira Server / Data Center app) and
// turn them into the same rows a CSV export would have, so the normal import preview, column matching and
// "update existing" modes apply. Nothing is stored: the token lives only for the request.

const { call, validateBase, IntegrationError } = require('./integrations');

const MAX_CASES = 2000;
const DEADLINE_MS = 170000;
const HEADERS = ['Key', 'Name', 'Objective', 'Precondition', 'Priority', 'Status', 'Folder', 'Labels', 'Gherkin script', 'Test Script - Step', 'Test Script - Test Data', 'Test Script - Expected Result'];

const text = (v) => (v == null ? '' : String(v));
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i); }));
  return out;
}

// One test case as rows: its fields on the first row, then one row per step. `steps` are { action, data, expected }.
function rowsFor(c, steps) {
  const head = [c.key, c.name, c.objective, c.precondition, c.priority, c.status, c.folder, c.labels, c.bdd || ''];
  if (!steps.length) return [[...head, '', '', '']];
  return steps.map((s, i) => (i === 0 ? [...head, s.action, s.data, s.expected] : ['', '', '', '', '', '', '', '', '', s.action, s.data, s.expected]));
}

// ----- Zephyr Scale Cloud: https://api.zephyrscale.smartbear.com/v2, a bearer token -----
async function fromCloud(cfg, token, deadline) {
  const get = (path) => {
    if (Date.now() > deadline) throw new IntegrationError('Zephyr Scale took too long. Try again, or export from Zephyr Scale and import the file.');
    return call('Zephyr Scale', cfg.base, token, 'GET', path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  };
  const key = encodeURIComponent(cfg.projectKey);
  const all = async (path, limit = 1000) => { // follows startAt/isLast paging
    const out = [];
    for (let start = 0; out.length < limit; ) {
      const r = await get(`${path}${path.includes('?') ? '&' : '?'}maxResults=100&startAt=${start}`);
      const vals = (r && r.values) || [];
      out.push(...vals);
      if (!vals.length || r.isLast !== false) break;
      start += vals.length;
    }
    return out;
  };
  const byId = (list) => new Map(list.map((x) => [String(x.id), x.name]));
  const priorities = byId(await all(`/priorities?projectKey=${key}`));
  const statuses = byId(await all(`/statuses?projectKey=${key}&statusType=TEST_CASE`));
  const folderList = await all(`/folders?projectKey=${key}&folderType=TEST_CASE`, 5000);
  const folders = new Map(folderList.map((f) => [String(f.id), f]));
  const pathOf = (id) => { const parts = []; for (let f = folders.get(String(id)), n = 0; f && n < 50; f = folders.get(String(f.parentId)), n++) parts.unshift(f.name); return parts.length ? `/${parts.join('/')}` : ''; };

  const cases = await all(`/testcases?projectKey=${key}`, MAX_CASES);
  const rows = await pool(cases, 5, async (c) => {
    let steps = [], bdd = '';
    const r = await all(`/testcases/${encodeURIComponent(c.key)}/teststeps`, 500);
    for (const s of r) {
      if (s.inline) steps.push({ action: text(s.inline.description), data: text(s.inline.testData), expected: text(s.inline.expectedResult) });
      else if (s.testCase && (s.testCase.testCaseKey || s.testCase.key)) steps.push({ action: `Call test case ${s.testCase.testCaseKey || s.testCase.key}`, data: '', expected: '' });
    }
    if (!steps.length && c.testScript) {
      try { const sc = await get(`/testcases/${encodeURIComponent(c.key)}/testscript`); if (sc && /bdd/i.test(sc.type) && sc.text) bdd = text(sc.text); } catch { /* no script */ }
    }
    return rowsFor({ key: c.key, name: text(c.name), objective: text(c.objective), precondition: text(c.precondition),
      priority: c.priority ? priorities.get(String(c.priority.id)) || '' : '', status: c.status ? statuses.get(String(c.status.id)) || '' : '',
      folder: c.folder ? pathOf(c.folder.id) : '', labels: (c.labels || []).join(', '), bdd }, steps);
  });
  return { rows: rows.flat(), count: cases.length, capped: cases.length >= MAX_CASES };
}

// ----- Zephyr Scale on Jira Server / Data Center: {jira}/rest/atm/1.0, the same login as Jira -----
async function fromServer(cfg, token, deadline) {
  const get = (path) => {
    if (Date.now() > deadline) throw new IntegrationError('Zephyr Scale took too long. Try again, or export from Zephyr Scale and import the file.');
    return call('Zephyr Scale', cfg.base, token, 'GET', path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  };
  const fields = 'key,name,objective,precondition,priority,status,folder,labels,testScript';
  const query = encodeURIComponent(`projectKey = "${cfg.projectKey}"`);
  const cases = [];
  for (let start = 0; cases.length < MAX_CASES; ) {
    const page = await get(`/rest/atm/1.0/testcase/search?query=${query}&fields=${fields}&maxResults=100&startAt=${start}`);
    if (!Array.isArray(page)) throw new IntegrationError('Zephyr Scale answered in a format Proofdeck does not know. Check the Jira URL and that the Zephyr Scale app is installed.');
    cases.push(...page);
    if (page.length < 100) break;
    start += page.length;
  }
  const rows = [];
  for (const c of cases) {
    const ts = c.testScript || {};
    const steps = /bdd/i.test(ts.type) ? [] : (ts.steps || []).map((s) => (s.testCaseKey ? { action: `Call test case ${s.testCaseKey}`, data: '', expected: '' } : { action: text(s.description), data: text(s.testData), expected: text(s.expectedResult) }));
    rows.push(...rowsFor({ key: c.key, name: text(c.name), objective: text(c.objective), precondition: text(c.precondition), priority: text(c.priority), status: text(c.status),
      folder: text(c.folder), labels: (c.labels || []).join(', '), bdd: /bdd/i.test(ts.type) ? text(ts.text) : '' }, steps));
  }
  return { rows, count: cases.length, capped: cases.length >= MAX_CASES };
}

async function fetchTable(input) {
  const variant = input.variant === 'server' ? 'server' : 'cloud';
  const projectKey = text(input.projectKey).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(projectKey)) throw new IntegrationError('The Jira project key looks wrong, e.g. PROJ');
  const token = text(input.token).trim();
  if (!token) throw new IntegrationError('Enter an API token');
  const cfg = { variant, projectKey, base: validateBase(variant === 'cloud' ? input.base || 'https://api.zephyrscale.smartbear.com/v2' : input.base, variant === 'cloud' ? 'Zephyr Scale API URL' : 'Jira URL') };
  const deadline = Date.now() + DEADLINE_MS;
  const r = variant === 'cloud' ? await fromCloud(cfg, token, deadline) : await fromServer(cfg, token, deadline);
  if (!r.rows.length) throw new IntegrationError(`Zephyr Scale has no test cases in project ${projectKey}`);
  // drop the Gherkin column when nothing uses it, so the column matcher is not offered an empty one
  const keep = HEADERS.map((_, i) => i !== 8 || r.rows.some((x) => x[8]));
  return { headers: HEADERS.filter((_, i) => keep[i]), rows: r.rows.map((x) => x.filter((_, i) => keep[i])), count: r.count, capped: r.capped };
}

module.exports = { fetchTable, MAX_CASES };
