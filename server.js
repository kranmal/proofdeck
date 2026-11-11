'use strict';
// Proofdeck — test management with one-click bug reports from failed steps.
// Zero dependencies: Node >= 22.13 (built-in node:sqlite).

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const importer = require('./lib/import');
const exporter = require('./lib/export');
const authRoutes = require('./routes/auth');
const tokens = require('./routes/tokens');
const secret = require('./lib/secret');

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 4780;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 20 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_FILE = 14 * 1024 * 1024; // JSON + base64 overhead keeps a request under MAX_BODY
// Allowed attachments. Images and video show inline; everything else downloads. Nothing that can run script (html, svg, js).
const FILE_TYPES = {
  'image/png': { image: true, sig: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { image: true, sig: [0xff, 0xd8, 0xff] },
  'image/gif': { image: true, sig: [0x47, 0x49, 0x46, 0x38] },
  'image/webp': { image: true, riff: 'WEBP' },
  'application/pdf': { sig: [0x25, 0x50, 0x44, 0x46] },
  'application/zip': { sig: [0x50, 0x4b] },
  'video/mp4': { inline: true, ftyp: true },
  'video/webm': { inline: true, sig: [0x1a, 0x45, 0xdf, 0xa3] },
  'text/plain': { text: true },
  'text/csv': { text: true },
  'application/json': { text: true },
};
// The bytes must match the claimed type, so a renamed file cannot sneak in as something else.
function looksLike(type, b) {
  const t = FILE_TYPES[type];
  if (t.sig) return t.sig.every((x, i) => b[i] === x);
  if (t.riff) return b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === t.riff;
  if (t.ftyp) return b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp';
  if (t.text) return !b.subarray(0, 8192).includes(0);
  return false;
}

const STEP_STATUS = ['Not Executed', 'Pass', 'Fail', 'Blocked'];
const EXEC_STATUS = ['Not Executed', 'In Progress', 'Pass', 'Fail', 'Blocked'];
const ENUMS = {
  cases: { priority: ['High', 'Medium', 'Low'], status: ['Draft', 'Approved', 'Deprecated'] },
  bugs: {
    status: ['Open', 'In Progress', 'Resolved', 'Closed'],
    severity: ['Critical', 'Major', 'Minor', 'Trivial'],
    priority: ['High', 'Medium', 'Low'],
  },
};

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'proofdeck.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  next_case INTEGER NOT NULL DEFAULT 1, next_cycle INTEGER NOT NULL DEFAULT 1, next_bug INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'tester', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bug_comments (
  id INTEGER PRIMARY KEY, bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS case_versions (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, snapshot TEXT NOT NULL, author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', UNIQUE(case_id, version)
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS case_links (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  ref TEXT NOT NULL COLLATE NOCASE, title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', UNIQUE(case_id, ref)
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL, UNIQUE(project_id, path)
);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, title TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '', precondition TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'Medium', status TEXT NOT NULL DEFAULT 'Draft',
  folder TEXT NOT NULL DEFAULT '', labels TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, action TEXT NOT NULL DEFAULT '', test_data TEXT NOT NULL DEFAULT '', expected TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '', build TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
-- Executions snapshot the case at the moment it is added to a cycle, so later
-- edits to the case never rewrite the history of a run.
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY, cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  case_key TEXT NOT NULL, case_title TEXT NOT NULL, precondition TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Not Executed', comment TEXT NOT NULL DEFAULT '', executed_at TEXT
);
CREATE TABLE IF NOT EXISTS step_results (
  id INTEGER PRIMARY KEY, execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, action TEXT NOT NULL, test_data TEXT NOT NULL, expected TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Not Executed', actual TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bugs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open', severity TEXT NOT NULL DEFAULT 'Major', priority TEXT NOT NULL DEFAULT 'Medium',
  environment TEXT NOT NULL DEFAULT '', expected TEXT NOT NULL DEFAULT '', actual TEXT NOT NULL DEFAULT '',
  steps_to_reproduce TEXT NOT NULL DEFAULT '',
  case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  execution_id INTEGER REFERENCES executions(id) ON DELETE SET NULL,
  step_result_id INTEGER REFERENCES step_results(id) ON DELETE SET NULL,
  case_key TEXT NOT NULL DEFAULT '', cycle_key TEXT NOT NULL DEFAULT '', step_no INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, owner_type TEXT NOT NULL, owner_id INTEGER NOT NULL,
  filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_owner ON attachments(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_steps_case ON steps(case_id);
CREATE INDEX IF NOT EXISTS idx_exec_cycle ON executions(cycle_id);
CREATE INDEX IF NOT EXISTS idx_sr_exec ON step_results(execution_id);
`);

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const now = () => new Date().toISOString();
// A response that is not JSON (file downloads).
class Raw { constructor(body, headers) { this.body = body; this.headers = headers; } }
// Folder paths: segments joined by "/", no empty segments, no stray spaces.
const normFolder = (f) => str(f).split('/').map((x) => x.trim()).filter(Boolean).join('/').slice(0, 300);
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const str = (x, d = '') => (x == null ? d : String(x));
const q = (sql) => db.prepare(sql);
const need = (row, what = 'Record') => { if (!row) throw new HttpError(404, `${what} not found`); return row; };

// Additive migrations, safe to run on every start.
function addColumn(table, col, ddl) {
  if (!q(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
const USER_REF = 'INTEGER REFERENCES users(id) ON DELETE SET NULL';
// Standalone ("ad hoc") runs live in one cycle per project.
addColumn('cycles', 'adhoc', 'INTEGER NOT NULL DEFAULT 0');
addColumn('cycles', 'created_by', USER_REF);
addColumn('cases', 'created_by', USER_REF);
addColumn('cases', 'updated_by', USER_REF);
addColumn('executions', 'executed_by', USER_REF);
addColumn('executions', 'assignee_id', USER_REF);
addColumn('bugs', 'reported_by', USER_REF);
addColumn('bugs', 'assignee_id', USER_REF);
addColumn('cases', 'version', 'INTEGER NOT NULL DEFAULT 1');
addColumn('projects', 'next_plan', 'INTEGER NOT NULL DEFAULT 1');
addColumn('cycles', 'plan_id', 'INTEGER REFERENCES plans(id) ON DELETE SET NULL');
// Reuse: steps that call another test case, and data sets (one execution per row).
addColumn('steps', 'call_case_id', 'INTEGER REFERENCES cases(id) ON DELETE SET NULL');
addColumn('cases', 'params', "TEXT NOT NULL DEFAULT ''");
addColumn('executions', 'executed_by_label', "TEXT NOT NULL DEFAULT ''"); // who ran it when it was not a signed-in user (an API token)
addColumn('executions', 'iteration', 'INTEGER NOT NULL DEFAULT 0');
addColumn('executions', 'iteration_label', "TEXT NOT NULL DEFAULT ''");
addColumn('executions', 'run_id', "TEXT NOT NULL DEFAULT ''");
addColumn('step_results', 'origin', "TEXT NOT NULL DEFAULT ''");
// Automation key: how a CI test or script is matched to its test case. Unique per project when set.
addColumn('cases', 'automation_key', "TEXT NOT NULL DEFAULT ''");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_case_autokey ON cases(project_id, automation_key) WHERE automation_key != ''");
addColumn('executions', 'case_version', 'INTEGER');

// A plan id belonging to the project, or null for "no plan".
function planOrNull(projectId, v) {
  if (v === null || v === '' || v === undefined) return null;
  const id = Number(v);
  if (!Number.isInteger(id) || !q('SELECT 1 FROM plans WHERE id=? AND project_id=?').get(id, projectId)) throw new HttpError(400, 'Unknown test plan');
  return id;
}

const autoKeyTaken = (projectId, key, exceptId) => q('SELECT key FROM cases WHERE project_id=? AND automation_key=? AND id!=?').get(projectId, key, exceptId);
function setAutomationKey(caseId, projectId, value) {
  const v = str(value).trim().slice(0, 300);
  const clash = v && autoKeyTaken(projectId, v, caseId);
  if (clash) throw new HttpError(409, `The automation key “${v}” is already used by ${clash.key}`);
  q('UPDATE cases SET automation_key=? WHERE id=?').run(v, caseId);
}

// An assignee is a user id, or null for "unassigned".
function assigneeOrNull(v) {
  if (v === null || v === '' || v === undefined) return null;
  const id = Number(v);
  if (!Number.isInteger(id) || !q('SELECT 1 FROM users WHERE id=? AND active=1').get(id)) throw new HttpError(400, 'Unknown user');
  return id;
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function nextKey(projectId, kind) {
  const col = { case: 'next_case', cycle: 'next_cycle', bug: 'next_bug', plan: 'next_plan' }[kind];
  const letter = { case: 'T', cycle: 'C', bug: 'B', plan: 'P' }[kind];
  const p = need(q(`SELECT key, ${col} AS n FROM projects WHERE id=?`).get(projectId), 'Project');
  q(`UPDATE projects SET ${col}=${col}+1 WHERE id=?`).run(projectId);
  return `${p.key}-${letter}${p.n}`;
}

function checkEnum(table, field, value) {
  const allowed = ENUMS[table] && ENUMS[table][field];
  if (allowed && !allowed.includes(value)) throw new HttpError(400, `Invalid ${field}: ${value}`);
}

function update(table, id, body, fields) {
  const sets = [], vals = [];
  for (const f of fields) {
    if (body[f] === undefined) continue;
    let v = str(body[f]);
    if (table === 'cases' && f === 'folder') v = normFolder(v);
    checkEnum(table, f, v);
    sets.push(`${f}=?`); vals.push(v);
  }
  if (sets.length) q(`UPDATE ${table} SET ${sets.join(',')}, updated_at=? WHERE id=?`).run(...vals, now(), id);
}

// Can `from` reach `target` by following "call test case" steps?
function callsReach(from, target) {
  const seen = new Set(), stack = [from];
  while (stack.length) {
    const id = stack.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const r of q('SELECT call_case_id FROM steps WHERE case_id=? AND call_case_id IS NOT NULL').all(id)) stack.push(r.call_case_id);
  }
  return false;
}

function replaceSteps(caseId, steps) {
  const owner = need(q('SELECT project_id FROM cases WHERE id=?').get(caseId), 'Test case');
  q('DELETE FROM steps WHERE case_id=?').run(caseId);
  const ins = q('INSERT INTO steps(case_id, position, action, test_data, expected, call_case_id) VALUES (?,?,?,?,?,?)');
  let pos = 0;
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s) continue;
    const call = Number(s.call_case_id) || null;
    if (call) {
      if (!q('SELECT 1 FROM cases WHERE id=? AND project_id=?').get(call, owner.project_id)) throw new HttpError(400, 'The test case to call was not found in this project');
      if (callsReach(call, caseId)) throw new HttpError(400, 'A test case cannot call itself, directly or through other test cases');
      ins.run(caseId, ++pos, '', '', '', call);
    } else if (str(s.action).trim() || str(s.expected).trim() || str(s.test_data).trim()) {
      ins.run(caseId, ++pos, str(s.action), str(s.test_data), str(s.expected), null);
    }
  }
}

// The steps a run executes: call steps are replaced by the called case's steps (recursively), tagged with its key.
function expandSteps(caseId, depth = 0, origin = '') {
  const out = [];
  for (const s of q('SELECT * FROM steps WHERE case_id=? ORDER BY position').all(caseId)) {
    if (s.call_case_id) {
      const t = q('SELECT key FROM cases WHERE id=?').get(s.call_case_id);
      if (t && depth < 8) out.push(...expandSteps(s.call_case_id, depth + 1, t.key));
    } else out.push({ action: s.action, test_data: s.test_data, expected: s.expected, origin });
  }
  return out;
}

// Steps that call a case that is about to be deleted are removed, and each caller gets a new version saying so.
function detachCalls(caseId, userId) {
  const callers = q('SELECT DISTINCT case_id FROM steps WHERE call_case_id=?').all(caseId).map((r) => r.case_id);
  const gone = (q('SELECT key FROM cases WHERE id=?').get(caseId) || {}).key || '';
  for (const cid of callers) {
    q('DELETE FROM steps WHERE case_id=? AND call_case_id=?').run(cid, caseId);
    q('SELECT id FROM steps WHERE case_id=? ORDER BY position').all(cid).forEach((r, i) => q('UPDATE steps SET position=? WHERE id=?').run(i + 1, r.id));
    versions.recordVersion(cid, userId, { note: `Step calling ${gone} removed because ${gone} was deleted` });
  }
}

// Data sets: { columns: [...], rows: [[...], ...] } stored as JSON text, or '' for none.
function cleanParams(input) {
  if (input === undefined || input === null || input === '') return '';
  const p = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return null; } })() : input;
  if (!p || !Array.isArray(p.columns) || !Array.isArray(p.rows)) throw new HttpError(400, 'Data sets must have columns and rows');
  const columns = p.columns.map((c) => str(c).trim());
  if (!columns.length) return '';
  if (columns.length > 20) throw new HttpError(400, 'At most 20 data set columns');
  if (columns.some((c) => !/^[A-Za-z_][A-Za-z0-9_ ]{0,39}$/.test(c))) throw new HttpError(400, 'Column names start with a letter and use only letters, digits, spaces and underscores');
  if (new Set(columns.map((c) => c.toLowerCase())).size !== columns.length) throw new HttpError(400, 'Column names must be different');
  if (p.rows.length > 200) throw new HttpError(400, 'At most 200 data set rows');
  const rows = p.rows.filter(Array.isArray).map((r) => columns.map((_, i) => str(r[i]).slice(0, 1000))).filter((r) => r.some((c) => c !== ''));
  return JSON.stringify({ columns, rows });
}
function parseParams(text) {
  try { const p = JSON.parse(text); if (p && Array.isArray(p.columns) && Array.isArray(p.rows)) return p; } catch { /* none */ }
  return { columns: [], rows: [] };
}

const versions = require('./lib/versions')({ q, now, str, normFolder, replaceSteps, checkEnum, HttpError });
const links = require('./lib/links')({ q, str, HttpError });
versions.backfill();

function insertCase(projectId, d, userId = null) {
  const priority = str(d.priority, 'Medium'), status = str(d.status, 'Draft');
  checkEnum('cases', 'priority', priority); checkEnum('cases', 'status', status);
  const key = nextKey(projectId, 'case');
  const t = now();
  const id = Number(q(`INSERT INTO cases(project_id, key, title, objective, precondition, priority, status, folder, labels, created_at, updated_at, created_by, updated_by, params)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, key, str(d.title).trim(), str(d.objective), str(d.precondition), priority, status,
    normFolder(d.folder), str(d.labels).trim(), t, t, userId, userId, cleanParams(d.params)).lastInsertRowid);
  replaceSteps(id, d.steps);
  if (d.links !== undefined) links.replaceLinks(id, d.links);
  if (str(d.automation_key).trim()) setAutomationKey(id, projectId, d.automation_key);
  versions.recordVersion(id, userId);
  return { id, key };
}

// Freeze a case (title, preconditions, steps) into a new execution of the given cycle.
function snapshotCase(cycleId, c, { rows = null } = {}) {
  const steps = expandSteps(c.id);
  const data = parseParams(c.params);
  const iterations = data.columns.length && data.rows.length ? (rows || data.rows.map((_, i) => i)) : [null];
  const runId = crypto.randomBytes(6).toString('hex');
  const insExec = q('INSERT INTO executions(cycle_id, case_id, case_key, case_title, precondition, case_version, iteration, iteration_label, run_id) VALUES (?,?,?,?,?,?,?,?,?)');
  const insStep = q('INSERT INTO step_results(execution_id, position, action, test_data, expected, origin) VALUES (?,?,?,?,?,?)');
  const ids = [];
  for (const idx of iterations) {
    const vars = idx === null ? null : Object.fromEntries(data.columns.map((col, j) => [col.toLowerCase(), str(data.rows[idx][j])]));
    const sub = (t) => (vars ? t.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => (k.toLowerCase() in vars ? vars[k.toLowerCase()] : m)) : t);
    const label = vars ? data.columns.slice(0, 3).map((col, j) => `${col}=${str(data.rows[idx][j])}`).join('; ').slice(0, 200) : '';
    const execId = Number(insExec.run(cycleId, c.id, c.key, c.title, sub(c.precondition), c.version, idx === null ? 0 : idx + 1, label, runId).lastInsertRowid);
    steps.forEach((s, i) => insStep.run(execId, i + 1, sub(s.action), sub(s.test_data), sub(s.expected), s.origin));
    ids.push(execId);
  }
  return ids;
}

function addCasesToCycle(cycleId, projectId, caseIds) {
  const getCase = q('SELECT * FROM cases WHERE id=? AND project_id=?');
  const exists = q('SELECT 1 FROM executions WHERE cycle_id=? AND case_id=?');
  let added = 0;
  for (const raw of Array.isArray(caseIds) ? caseIds : []) {
    const c = getCase.get(Number(raw), projectId);
    if (!c || exists.get(cycleId, c.id)) continue;
    snapshotCase(cycleId, c);
    added++;
  }
  return added;
}

// Execution status follows its steps: any Fail > any Blocked > all Pass > partially done.
function rollup(execId, userId = null) {
  const s = q('SELECT status FROM step_results WHERE execution_id=?').all(execId).map((r) => r.status);
  if (!s.length) return;
  let st = 'Not Executed';
  if (s.includes('Fail')) st = 'Fail';
  else if (s.includes('Blocked')) st = 'Blocked';
  else if (s.every((x) => x === 'Pass')) st = 'Pass';
  else if (s.some((x) => x !== 'Not Executed')) st = 'In Progress';
  q('UPDATE executions SET status=?, executed_at=?, executed_by=? WHERE id=?')
    .run(st, st === 'Not Executed' ? null : now(), st === 'Not Executed' ? null : userId, execId);
}

function checkUpload(body, { imageOnly = false } = {}) {
  const mime = str(body.mime).toLowerCase();
  const t = FILE_TYPES[mime];
  if (!t || (imageOnly && !t.image)) {
    throw new HttpError(400, imageOnly ? 'Only PNG, JPEG, GIF or WebP images are accepted' : 'That file type is not allowed. Use images, PDF, text, CSV, JSON, ZIP, MP4 or WebM.');
  }
  const data = Buffer.from(str(body.data), 'base64');
  if (!data.length) throw new HttpError(400, 'Empty file');
  if (data.length > (t.image ? MAX_IMAGE : MAX_FILE)) throw new HttpError(413, `File is larger than ${t.image ? 10 : 14} MB`);
  if (!looksLike(mime, data)) throw new HttpError(400, 'The file content does not match its type');
  return { mime, data };
}

function saveAttachment(ownerType, ownerId, body) {
  const { mime, data } = checkUpload(body);
  const filename = path.basename(str(body.filename, 'attachment')).replace(/[\u0000-\u001f"\\]/g, '_').slice(0, 120) || 'attachment';
  const id = q('INSERT INTO attachments(owner_type, owner_id, filename, mime, size, data, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(ownerType, ownerId, filename, mime, data.length, data, now()).lastInsertRowid;
  return { id: Number(id), filename };
}

const attachmentsOf = (type, id) =>
  q('SELECT id, filename, mime, size FROM attachments WHERE owner_type=? AND owner_id=? ORDER BY id').all(type, id);

const CYCLE_COUNTS = `
  COUNT(e.id) AS total,
  COALESCE(SUM(e.status='Pass'),0) AS pass, COALESCE(SUM(e.status='Fail'),0) AS fail,
  COALESCE(SUM(e.status='Blocked'),0) AS blocked, COALESCE(SUM(e.status='In Progress'),0) AS in_progress,
  COALESCE(SUM(e.status='Not Executed'),0) AS not_executed`;

// ---------- routes ----------
const routes = [];
// opts: { public } no sign-in needed · { admin } admins only · { viewer } read-only accounts may call it too.
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}

route('GET', '/api/projects', () => q('SELECT id, key, name FROM projects ORDER BY name').all());

route('POST', '/api/projects', ({ body }) => {
  const name = str(body.name).trim();
  const key = str(body.key).trim().toUpperCase();
  if (!name) throw new HttpError(400, 'Project name is required');
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new HttpError(400, 'Key must be 2-10 letters/digits, starting with a letter');
  if (q('SELECT 1 FROM projects WHERE key=?').get(key)) throw new HttpError(409, `Key ${key} is already in use`);
  const id = q('INSERT INTO projects(key, name, created_at) VALUES (?,?,?)').run(key, name, now()).lastInsertRowid;
  return { id: Number(id), key, name };
});

route('GET', '/api/projects/:pid/summary', ({ params, user }) => {
  const pid = params.pid;
  need(q('SELECT 1 FROM projects WHERE id=?').get(pid), 'Project');
  return {
    cases: q('SELECT COUNT(*) n FROM cases WHERE project_id=?').get(pid).n,
    cycles: q('SELECT COUNT(*) n FROM cycles WHERE project_id=?').get(pid).n,
    openBugs: q("SELECT COUNT(*) n FROM bugs WHERE project_id=? AND status IN ('Open','In Progress')").get(pid).n,
    totals: q(`SELECT ${CYCLE_COUNTS} FROM executions e JOIN cycles c ON c.id=e.cycle_id WHERE c.project_id=?`).get(pid),
    recentCycles: q(`SELECT c.id, c.key, c.name, c.environment, c.build, c.adhoc, ${CYCLE_COUNTS}
      FROM cycles c LEFT JOIN executions e ON e.cycle_id=c.id WHERE c.project_id=? GROUP BY c.id ORDER BY c.id DESC LIMIT 5`).all(pid),
    recentBugs: q('SELECT id, key, title, status, severity, created_at FROM bugs WHERE project_id=? ORDER BY id DESC LIMIT 6').all(pid),
    mine: {
      bugs: q("SELECT COUNT(*) n FROM bugs WHERE project_id=? AND assignee_id=? AND status IN ('Open','In Progress')").get(pid, user.id).n,
      runs: q(`SELECT COUNT(*) n FROM executions e JOIN cycles c ON c.id=e.cycle_id
        WHERE c.project_id=? AND c.adhoc=0 AND e.assignee_id=? AND e.status IN ('Not Executed','In Progress')`).get(pid, user.id).n,
    },
  };
});

// --- test cases ---
route('GET', '/api/projects/:pid/cases', ({ params }) =>
  q(`SELECT c.id, c.key, c.title, c.priority, c.status, c.folder, c.labels, c.updated_at, c.automation_key,
      (SELECT COUNT(*) FROM steps s WHERE s.case_id=c.id) AS step_count,
      (SELECT e.status FROM executions e WHERE e.case_id=c.id AND e.executed_at IS NOT NULL
         ORDER BY e.executed_at DESC LIMIT 1) AS last_status,
      (SELECT COUNT(*) FROM bugs b WHERE b.case_id=c.id AND b.status IN ('Open','In Progress')) AS open_bugs,
      (SELECT group_concat(ref, ' ') FROM case_links l WHERE l.case_id=c.id) AS refs
    FROM cases c WHERE c.project_id=? ORDER BY c.id`).all(params.pid));

route('POST', '/api/projects/:pid/cases', ({ params, body, user }) => {
  const title = str(body.title).trim();
  if (!title) throw new HttpError(400, 'Title is required');
  return tx(() => insertCase(params.pid, body, user.id));
});

// --- import (CSV / Excel) ---
route('POST', '/api/import/parse', ({ body }) => {
  try { return importer.parseTable(Buffer.from(str(body.data), 'base64'), body.sheet); }
  catch (e) { if (e instanceof importer.ImportError) throw new HttpError(400, e.message); throw e; }
});

// Apply a row group from a file to an existing test case. Only the columns the file maps are touched; steps are
// replaced only if the file has steps for the case; priority/status only if the file really gave a known value.
function applyImportUpdate(existing, c, mapped, userId) {
  const sets = [], vals = [];
  const set = (f, v) => { sets.push(`${f}=?`); vals.push(v); };
  if (mapped.includes('title') && c.title) set('title', c.title);
  for (const f of ['objective', 'precondition']) if (mapped.includes(f)) set(f, c[f]);
  if (mapped.includes('labels')) set('labels', str(c.labels).trim());
  if (mapped.includes('priority') && c.has.priority) set('priority', c.priority);
  if (mapped.includes('status') && c.has.status) set('status', c.status);
  if (mapped.includes('folder')) set('folder', normFolder(c.folder));
  if (sets.length) q(`UPDATE cases SET ${sets.join(', ')}, updated_at=?, updated_by=? WHERE id=?`).run(...vals, now(), userId, existing.id);
  if (c.steps.length) replaceSteps(existing.id, c.steps);
  if (mapped.includes('links')) links.replaceLinks(existing.id, c.links);
  let keyConflict = false;
  if (mapped.includes('automation_key') && c.automation_key) {
    if (autoKeyTaken(existing.project_id, c.automation_key, existing.id)) keyConflict = true;
    else q('UPDATE cases SET automation_key=? WHERE id=?').run(c.automation_key.slice(0, 300), existing.id);
  }
  versions.recordVersion(existing.id, userId, { note: 'Updated by import' });
  return keyConflict;
}

// mode: "create" always adds new cases; "update_id" updates the case whose key equals the file's ID; "update_title"
// updates the single case with the same title and folder. Anything that does not match is created.
route('POST', '/api/projects/:pid/import', ({ params, body, user }) => {
  need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
  const mode = str(body.mode, 'create');
  if (!['create', 'update_id', 'update_title'].includes(mode)) throw new HttpError(400, 'Unknown import mode');
  let built;
  try { built = importer.buildCases(body.rows, body.mapping, { stripHtml: !!body.stripHtml }); }
  catch (e) { if (e instanceof importer.ImportError) throw new HttpError(400, e.message); throw e; }
  const { cases, skipped, mapped } = built;

  const existing = q('SELECT id, project_id, key, title, folder FROM cases WHERE project_id=?').all(params.pid);
  const byKey = new Map(existing.map((c) => [c.key.toLowerCase(), c]));
  const plan = cases.map((c) => {
    if (mode === 'update_id' && c.key && byKey.has(c.key.toLowerCase())) return { c, target: byKey.get(c.key.toLowerCase()) };
    if (mode === 'update_title') {
      const hits = existing.filter((e) => e.title.toLowerCase() === c.title.toLowerCase() && e.folder === normFolder(c.folder));
      if (hits.length === 1) return { c, target: hits[0] };
      if (hits.length > 1) return { c, ambiguous: true };
    }
    return { c };
  });
  const summary = {
    cases: cases.length, steps: cases.reduce((n, c) => n + c.steps.length, 0), skipped,
    withoutSteps: cases.filter((c) => !c.steps.length).length,
    created: plan.filter((x) => !x.target && !x.ambiguous).length, updated: plan.filter((x) => x.target).length, ambiguous: plan.filter((x) => x.ambiguous).length,
    preview: plan.slice(0, 5).map((x) => ({ title: x.c.title, folder: x.c.folder, priority: x.c.priority, status: x.c.status, steps: x.c.steps.length,
      action: x.target ? 'update' : x.ambiguous ? 'ambiguous' : 'create', target: x.target ? x.target.key : '' })),
  };
  if (body.dryRun) return summary;
  if (!cases.length) throw new HttpError(400, 'No test cases found with this column mapping');
  if (cases.length > 2000) throw new HttpError(400, 'More than 2000 test cases in one file. Split the file and import in parts.');
  return tx(() => {
    const createdKeys = [], updatedKeys = [];
    let keyConflicts = 0;
    for (const x of plan) {
      if (x.ambiguous) continue;
      if (x.target) { if (applyImportUpdate(x.target, x.c, mapped, user.id)) keyConflicts++; updatedKeys.push(x.target.key); continue; }
      const c = { ...x.c };
      if (c.automation_key && autoKeyTaken(params.pid, c.automation_key, 0)) { keyConflicts++; c.automation_key = ''; }
      createdKeys.push(insertCase(params.pid, c, user.id).key);
    }
    return { ...summary, firstKey: createdKeys[0] || null, lastKey: createdKeys.at(-1) || null, updatedKeys: updatedKeys.slice(0, 50), keyConflicts };
  });
});

route('GET', '/api/cases/:id', ({ params }) => {
  const c = need(q(`SELECT c.*, (SELECT display_name FROM users WHERE id=c.created_by) AS created_by_name,
    (SELECT display_name FROM users WHERE id=c.updated_by) AS updated_by_name FROM cases c WHERE c.id=?`).get(params.id), 'Test case');
  c.steps = q(`SELECT s.id, s.position, s.action, s.test_data, s.expected, s.call_case_id,
      (SELECT key FROM cases WHERE id=s.call_case_id) AS call_key, (SELECT title FROM cases WHERE id=s.call_case_id) AS call_title,
      (SELECT COUNT(*) FROM steps x WHERE x.case_id=s.call_case_id) AS call_steps
    FROM steps s WHERE s.case_id=? ORDER BY s.position`).all(c.id);
  c.params = parseParams(c.params);
  c.links = links.linksOf(c);
  c.usedBy = q('SELECT DISTINCT c2.id, c2.key, c2.title FROM steps s JOIN cases c2 ON c2.id=s.case_id WHERE s.call_case_id=? ORDER BY c2.id').all(c.id);
  c.bugs = q('SELECT id, key, title, status, severity FROM bugs WHERE case_id=? ORDER BY id DESC').all(c.id);
  c.runs = q(`SELECT e.id, e.status, e.executed_at, cy.key AS cycle_key, cy.name AS cycle_name, cy.adhoc
    FROM executions e JOIN cycles cy ON cy.id=e.cycle_id WHERE e.case_id=? ORDER BY e.id DESC LIMIT 20`).all(c.id);
  return c;
});

// Run a single test case on its own, without planning a cycle first.
route('POST', '/api/cases/:id/run', ({ params, user }) => {
  const c = need(q('SELECT * FROM cases WHERE id=?').get(params.id), 'Test case');
  return tx(() => {
    let cyc = q('SELECT id FROM cycles WHERE project_id=? AND adhoc=1').get(c.project_id);
    if (!cyc) {
      const key = nextKey(c.project_id, 'cycle');
      cyc = { id: Number(q('INSERT INTO cycles(project_id, key, name, description, adhoc, created_at, created_by) VALUES (?,?,?,?,1,?,?)')
        .run(c.project_id, key, 'Standalone runs', 'Test cases run on their own, outside a planned cycle.', now(), user.id).lastInsertRowid) };
    }
    const executionIds = snapshotCase(cyc.id, c);
    return { executionId: executionIds[0], executionIds };
  });
});

route('PUT', '/api/cases/:id', ({ params, body, user }) => {
  need(q('SELECT 1 FROM cases WHERE id=?').get(params.id), 'Test case');
  if (body.title !== undefined && !str(body.title).trim()) throw new HttpError(400, 'Title is required');
  return tx(() => {
    update('cases', params.id, body, ['title', 'objective', 'precondition', 'priority', 'status', 'folder', 'labels']);
    q('UPDATE cases SET updated_by=? WHERE id=?').run(user.id, params.id);
    if (body.automation_key !== undefined) setAutomationKey(params.id, q('SELECT project_id FROM cases WHERE id=?').get(params.id).project_id, body.automation_key);
    if (body.params !== undefined) q('UPDATE cases SET params=? WHERE id=?').run(cleanParams(body.params), params.id);
    if (body.steps !== undefined) replaceSteps(params.id, body.steps);
    if (body.links !== undefined) links.replaceLinks(params.id, body.links);
    const version = versions.recordVersion(params.id, user.id);
    return { ok: true, version };
  });
});

route('POST', '/api/cases/:id/clone', ({ params, user }) => {
  const c = need(q('SELECT * FROM cases WHERE id=?').get(params.id), 'Test case');
  return tx(() => {
    const key = nextKey(c.project_id, 'case');
    const t = now();
    const id = Number(q(`INSERT INTO cases(project_id, key, title, objective, precondition, priority, status, folder, labels, created_at, updated_at, created_by, updated_by, params)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.project_id, key, `${c.title} (copy)`, c.objective, c.precondition, c.priority, 'Draft',
      c.folder, c.labels, t, t, user.id, user.id, c.params).lastInsertRowid);
    replaceSteps(id, q('SELECT action, test_data, expected, call_case_id FROM steps WHERE case_id=? ORDER BY position').all(c.id));
    links.copyLinks(c.id, id);
    versions.recordVersion(id, user.id);
    return { id, key };
  });
});

route('DELETE', '/api/cases/:id', ({ params, user }) => tx(() => {
  detachCalls(params.id, user.id);
  q('DELETE FROM cases WHERE id=?').run(params.id);
  return { ok: true };
}));

// --- version history ---
const versionAuthor = `(SELECT display_name FROM users WHERE id=v.author_id)`;
route('GET', '/api/cases/:id/versions', ({ params }) => {
  need(q('SELECT 1 FROM cases WHERE id=?').get(params.id), 'Test case');
  return q(`SELECT v.version, v.created_at, v.note, ${versionAuthor} AS author FROM case_versions v WHERE v.case_id=? ORDER BY v.version DESC`).all(params.id);
});

route('GET', '/api/cases/:id/versions/:v', ({ params }) => {
  const v = need(q(`SELECT v.version, v.snapshot, v.created_at, v.note, ${versionAuthor} AS author FROM case_versions v WHERE v.case_id=? AND v.version=?`).get(params.id, params.v), 'Version');
  return { ...v, snapshot: JSON.parse(v.snapshot) };
});

route('POST', '/api/cases/:id/versions/:v/restore', ({ params, user }) => {
  need(q('SELECT 1 FROM cases WHERE id=?').get(params.id), 'Test case');
  return tx(() => ({ version: versions.restoreVersion(params.id, params.v, user.id) }));
});

// --- folders ---
function allFolders(pid) {
  const set = new Set();
  const add = (p) => { const parts = p.split('/'); for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/')); };
  for (const r of q('SELECT path FROM folders WHERE project_id=?').all(pid)) add(r.path);
  for (const r of q("SELECT DISTINCT folder FROM cases WHERE project_id=? AND folder!=''").all(pid)) add(r.folder);
  return [...set].sort((a, b) => a.localeCompare(b));
}
const inSubtree = (path, root) => path === root || path.startsWith(root + '/');

// Move folder `from` (and everything below it) to path `to`. An empty `to` lifts the contents to the top level.
function moveFolder(pid, from, to) {
  const re = (path) => normFolder(to + path.slice(from.length));
  const upd = q('UPDATE cases SET folder=?, updated_at=? WHERE id=?');
  for (const c of q("SELECT id, folder FROM cases WHERE project_id=? AND folder!=''").all(pid)) {
    if (inSubtree(c.folder, from)) upd.run(re(c.folder), now(), c.id);
  }
  const ins = q('INSERT OR IGNORE INTO folders(project_id, path) VALUES (?,?)');
  const del = q('DELETE FROM folders WHERE project_id=? AND path=?');
  for (const f of q('SELECT path FROM folders WHERE project_id=?').all(pid)) {
    if (!inSubtree(f.path, from)) continue;
    del.run(pid, f.path);
    const np = re(f.path);
    if (np) ins.run(pid, np);
  }
}

route('GET', '/api/projects/:pid/folders', ({ params }) => allFolders(params.pid));

route('POST', '/api/projects/:pid/folders', ({ params, body }) => {
  need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
  const path = normFolder(body.path);
  if (!path) throw new HttpError(400, 'Folder name is required');
  q('INSERT OR IGNORE INTO folders(project_id, path) VALUES (?,?)').run(params.pid, path);
  return { path };
});

route('POST', '/api/projects/:pid/folders/rename', ({ params, body }) => {
  const from = normFolder(body.from), to = normFolder(body.to);
  if (!from || !to) throw new HttpError(400, 'Folder path is required');
  if (!allFolders(params.pid).includes(from)) throw new HttpError(404, 'Folder not found');
  if (to === from) return { path: to };
  if (to.startsWith(from + '/')) throw new HttpError(400, 'A folder cannot be moved into itself');
  return tx(() => { moveFolder(params.pid, from, to); return { path: to }; });
});

// Deleting a folder never deletes test cases: its contents move up one level.
route('POST', '/api/projects/:pid/folders/delete', ({ params, body }) => {
  const path = normFolder(body.path);
  if (!path) throw new HttpError(400, 'Folder path is required');
  return tx(() => { moveFolder(params.pid, path, parentOf(path)); return { path: parentOf(path) }; });
});

route('POST', '/api/projects/:pid/cases/bulk', ({ params, body, user }) => {
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 5000);
  if (!ids.length) throw new HttpError(400, 'No test cases selected');
  const folder = normFolder(body.folder);
  const action = str(body.action);
  if (action !== 'move' && action !== 'delete') throw new HttpError(400, 'Unknown action');
  return tx(() => {
    const stmt = action === 'move' ? q('UPDATE cases SET folder=?, updated_at=? WHERE id=? AND project_id=?') : q('DELETE FROM cases WHERE id=? AND project_id=?');
    let n = 0;
    for (const id of ids) {
      if (action === 'delete') detachCalls(id, user.id);
      n += Number(action === 'move' ? stmt.run(folder, now(), id, params.pid).changes : stmt.run(id, params.pid).changes);
    }
    return { count: n };
  });
});

// --- export ---
function sendTable(rows, format, base, sheetName, widths) {
  if (format !== 'csv' && format !== 'xlsx') throw new HttpError(400, 'Format must be csv or xlsx');
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
  const file = `${safe}-${now().slice(0, 10)}.${format}`;
  const headers = { 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'no-store' };
  return format === 'xlsx'
    ? new Raw(exporter.toXlsx(rows, { sheetName, widths }), { ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    : new Raw(Buffer.from(exporter.toCsv(rows), 'utf8'), { ...headers, 'Content-Type': 'text/csv; charset=utf-8' });
}

route('GET', '/api/projects/:pid/export', ({ params, query }) => {
  const p = need(q('SELECT key FROM projects WHERE id=?').get(params.pid), 'Project');
  let cases = q('SELECT * FROM cases WHERE project_id=? ORDER BY folder, id').all(params.pid);
  const ids = (query.get('ids') || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) { const want = new Set(ids); cases = cases.filter((c) => want.has(c.id)); }
  else if (query.has('folder')) {
    const f = normFolder(query.get('folder'));
    if (f) cases = cases.filter((c) => (query.get('deep') === '0' ? c.folder === f : inSubtree(c.folder, f)));
  }
  const byCase = new Map();
  for (const s of q('SELECT s.* FROM steps s JOIN cases c ON c.id=s.case_id WHERE c.project_id=? ORDER BY s.case_id, s.position').all(params.pid)) {
    if (!byCase.has(s.case_id)) byCase.set(s.case_id, []);
    byCase.get(s.case_id).push(s);
  }
  const names = new Map(q('SELECT id, key, title FROM cases WHERE project_id=?').all(params.pid).map((c) => [c.id, c]));
  const reqs = new Map();
  for (const l of q('SELECT l.case_id, l.ref FROM case_links l JOIN cases c ON c.id=l.case_id WHERE c.project_id=? ORDER BY l.id').all(params.pid)) {
    if (!reqs.has(l.case_id)) reqs.set(l.case_id, []);
    reqs.get(l.case_id).push(l.ref);
  }
  for (const c of cases) {
    c.requirements = (reqs.get(c.id) || []).join(', ');
    c.steps = (byCase.get(c.id) || []).map((s) => (s.call_case_id && names.has(s.call_case_id)
      ? { ...s, action: `Call test case ${names.get(s.call_case_id).key}: ${names.get(s.call_case_id).title}` } : s));
  }
  return sendTable(exporter.caseRows(cases), query.get('format') || 'xlsx', `${p.key}-test-cases`, 'Test cases', exporter.CASE_WIDTHS);
});

route('GET', '/api/cycles/:id/export', ({ params, query }) => {
  const cyc = need(q('SELECT * FROM cycles WHERE id=?').get(params.id), 'Cycle');
  const bugsBy = (col, id) => q(`SELECT key FROM bugs WHERE ${col}=? ORDER BY id`).all(id).map((b) => b.key);
  const execs = q('SELECT * FROM executions WHERE cycle_id=? ORDER BY id').all(cyc.id).map((e) => ({
    ...e,
    bugs: bugsBy('execution_id', e.id),
    steps: q('SELECT * FROM step_results WHERE execution_id=? ORDER BY position').all(e.id).map((s) => ({ ...s, bugs: bugsBy('step_result_id', s.id) })),
  }));
  return sendTable(exporter.resultRows(cyc, execs), query.get('format') || 'xlsx', `${cyc.key}-results`, 'Results', exporter.RESULT_WIDTHS);
});

// --- cycles ---
route('GET', '/api/projects/:pid/cycles', ({ params }) =>
  q(`SELECT c.id, c.key, c.name, c.environment, c.build, c.adhoc, c.created_at, c.plan_id,
       (SELECT key FROM plans WHERE id=c.plan_id) AS plan_key, (SELECT name FROM plans WHERE id=c.plan_id) AS plan_name, ${CYCLE_COUNTS}
     FROM cycles c LEFT JOIN executions e ON e.cycle_id=c.id WHERE c.project_id=? GROUP BY c.id ORDER BY c.id DESC`).all(params.pid));

route('POST', '/api/projects/:pid/cycles', ({ params, body, user }) => {
  const name = str(body.name).trim();
  if (!name) throw new HttpError(400, 'Cycle name is required');
  return tx(() => {
    const key = nextKey(params.pid, 'cycle');
    const id = Number(q('INSERT INTO cycles(project_id, key, name, description, environment, build, created_at, created_by, plan_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(params.pid, key, name, str(body.description), str(body.environment).trim(), str(body.build).trim(), now(), user.id, planOrNull(params.pid, body.plan_id)).lastInsertRowid);
    addCasesToCycle(id, params.pid, body.caseIds);
    return { id, key };
  });
});

route('GET', '/api/cycles/:id', ({ params }) => {
  const c = need(q('SELECT * FROM cycles WHERE id=?').get(params.id), 'Cycle');
  c.created_by_name = (q('SELECT display_name FROM users WHERE id=?').get(c.created_by || 0) || {}).display_name || '';
  const plan = c.plan_id ? q('SELECT key, name FROM plans WHERE id=?').get(c.plan_id) : null;
  c.plan_key = plan ? plan.key : '';
  c.plan_name = plan ? plan.name : '';
  c.executions = q(`SELECT e.id, e.case_id, e.case_key, e.case_title, e.status, e.executed_at, e.assignee_id, e.iteration, e.iteration_label,
      (SELECT display_name FROM users WHERE id=e.assignee_id) AS assignee_name,
      COALESCE((SELECT display_name FROM users WHERE id=e.executed_by), NULLIF(e.executed_by_label, '')) AS executed_by_name,
      (SELECT COUNT(*) FROM step_results s WHERE s.execution_id=e.id) AS step_count,
      (SELECT COUNT(*) FROM step_results s WHERE s.execution_id=e.id AND s.status!='Not Executed') AS steps_done,
      (SELECT COUNT(*) FROM bugs b WHERE b.execution_id=e.id) AS bug_count
    FROM executions e WHERE e.cycle_id=? ORDER BY e.id`).all(c.id);
  return c;
});

route('PUT', '/api/cycles/:id', ({ params, body }) => {
  const c = need(q('SELECT * FROM cycles WHERE id=?').get(params.id), 'Cycle');
  if (body.name !== undefined && !str(body.name).trim()) throw new HttpError(400, 'Cycle name is required');
  if (c.adhoc && body.plan_id) throw new HttpError(400, 'Standalone runs cannot be part of a plan');
  const plan = body.plan_id !== undefined ? planOrNull(c.project_id, body.plan_id) : c.plan_id;
  return tx(() => {
    for (const f of ['name', 'description', 'environment', 'build']) {
      if (body[f] !== undefined) q(`UPDATE cycles SET ${f}=? WHERE id=?`).run(str(body[f]).trim().slice(0, 5000), c.id);
    }
    q('UPDATE cycles SET plan_id=? WHERE id=?').run(plan, c.id);
    return { ok: true };
  });
});

route('POST', '/api/cycles/:id/cases', ({ params, body }) => {
  const c = need(q('SELECT id, project_id, adhoc FROM cycles WHERE id=?').get(params.id), 'Cycle');
  if (c.adhoc) throw new HttpError(400, 'Use “Run” on a test case to add a standalone run');
  return tx(() => ({ added: addCasesToCycle(c.id, c.project_id, body.caseIds) }));
});

// Clone a cycle: same environment/build, fresh results. Test cases are re-snapshotted from their latest saved steps.
route('POST', '/api/cycles/:id/clone', ({ params, body, user }) => {
  const src = need(q('SELECT * FROM cycles WHERE id=?').get(params.id), 'Cycle');
  if (src.adhoc) throw new HttpError(400, 'Standalone runs cannot be cloned');
  const filters = { all: null, unpassed: ['Fail', 'Blocked', 'Not Executed', 'In Progress'], failed: ['Fail', 'Blocked'] };
  const include = str(body.include, 'all');
  if (!(include in filters)) throw new HttpError(400, 'Invalid include option');
  const execs = q('SELECT * FROM executions WHERE cycle_id=? ORDER BY id').all(src.id).filter((e) => !filters[include] || filters[include].includes(e.status));
  if (!execs.length) throw new HttpError(400, 'No test cases match that choice');
  const name = str(body.name).trim() || `${src.name} (copy)`;
  return tx(() => {
    const key = nextKey(src.project_id, 'cycle');
    const id = Number(q('INSERT INTO cycles(project_id, key, name, description, environment, build, created_at, created_by, plan_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(src.project_id, key, name.slice(0, 200), src.description, body.environment !== undefined ? str(body.environment).trim() : src.environment,
        body.build !== undefined ? str(body.build).trim() : src.build, now(), user.id, body.plan_id !== undefined ? planOrNull(src.project_id, body.plan_id) : src.plan_id).lastInsertRowid);
    const seen = new Set();
    let added = 0;
    for (const e of execs) {
      const live = e.case_id ? q('SELECT * FROM cases WHERE id=?').get(e.case_id) : null;
      if (live) {
        // A data-set iteration is re-created from the same row of the current data set; plain runs are re-created in full.
        const tag = `${live.id}:${e.iteration}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        const data = parseParams(live.params);
        if (e.iteration > 0 && data.rows[e.iteration - 1]) added += snapshotCase(id, live, { rows: [e.iteration - 1] }).length;
        else if (e.iteration === 0 || !data.rows.length) added += snapshotCase(id, live).length;
        continue;
      }
      // The case was deleted: carry the old snapshot over so the cycle stays complete.
      const nid = Number(q('INSERT INTO executions(cycle_id, case_id, case_key, case_title, precondition, case_version, iteration, iteration_label, run_id) VALUES (?,NULL,?,?,?,?,?,?,?)')
        .run(id, e.case_key, e.case_title, e.precondition, e.case_version, e.iteration, e.iteration_label, e.run_id).lastInsertRowid);
      for (const st of q('SELECT * FROM step_results WHERE execution_id=? ORDER BY position').all(e.id)) {
        q('INSERT INTO step_results(execution_id, position, action, test_data, expected, origin) VALUES (?,?,?,?,?,?)').run(nid, st.position, st.action, st.test_data, st.expected, st.origin);
      }
      added++;
    }
    return { id, key, added };
  });
});

function deleteStepAttachments(where, arg) {
  q(`DELETE FROM attachments WHERE owner_type='step' AND owner_id IN
     (SELECT sr.id FROM step_results sr JOIN executions e ON e.id=sr.execution_id WHERE ${where})`).run(arg);
}

route('DELETE', '/api/cycles/:id', ({ params }) => tx(() => {
  deleteStepAttachments('e.cycle_id=?', params.id);
  q('DELETE FROM cycles WHERE id=?').run(params.id);
  return { ok: true };
}));

// --- executions ---
route('GET', '/api/executions/:id', ({ params }) => {
  const ex = need(q(`SELECT e.*, (SELECT display_name FROM users WHERE id=e.assignee_id) AS assignee_name,
    COALESCE((SELECT display_name FROM users WHERE id=e.executed_by), NULLIF(e.executed_by_label, '')) AS executed_by_name, c.key AS cycle_key, c.name AS cycle_name, c.environment, c.build, c.project_id, c.adhoc
    FROM executions e JOIN cycles c ON c.id=e.cycle_id WHERE e.id=?`).get(params.id), 'Execution');
  const atts = q(`SELECT a.id, a.owner_id, a.filename, a.mime, a.size FROM attachments a
    WHERE a.owner_type='step' AND a.owner_id IN (SELECT id FROM step_results WHERE execution_id=?) ORDER BY a.id`).all(ex.id);
  const bugs = q('SELECT id, key, title, status, step_result_id FROM bugs WHERE execution_id=? ORDER BY id').all(ex.id);
  ex.steps = q('SELECT * FROM step_results WHERE execution_id=? ORDER BY position').all(ex.id).map((s) => ({
    ...s,
    attachments: atts.filter((a) => a.owner_id === s.id),
    bugs: bugs.filter((b) => b.step_result_id === s.id),
  }));
  ex.current_version = ex.case_id ? (q('SELECT version FROM cases WHERE id=?').get(ex.case_id) || {}).version || null : null;
  // In a cycle, previous/next walk the whole cycle. Standalone runs are unrelated to each other, so only the
  // data-set iterations started together (same run) are neighbours.
  const sib = (ex.adhoc ? q('SELECT id FROM executions WHERE cycle_id=? AND run_id=? ORDER BY id').all(ex.cycle_id, ex.run_id)
    : q('SELECT id FROM executions WHERE cycle_id=? ORDER BY id').all(ex.cycle_id)).map((r) => r.id);
  const i = sib.indexOf(ex.id);
  ex.prev = sib[i - 1] ?? null;
  ex.next = sib[i + 1] ?? null;
  ex.index = i + 1;
  ex.count = sib.length;
  return ex;
});

route('PUT', '/api/executions/:id', ({ params, body, user }) => {
  need(q('SELECT 1 FROM executions WHERE id=?').get(params.id), 'Execution');
  if (body.comment !== undefined) q('UPDATE executions SET comment=? WHERE id=?').run(str(body.comment), params.id);
  if (body.assignee_id !== undefined) q('UPDATE executions SET assignee_id=? WHERE id=?').run(assigneeOrNull(body.assignee_id), params.id);
  if (body.status !== undefined) {
    if (!EXEC_STATUS.includes(body.status)) throw new HttpError(400, 'Invalid status');
    q('UPDATE executions SET status=?, executed_at=?, executed_by=? WHERE id=?')
      .run(body.status, body.status === 'Not Executed' ? null : now(), body.status === 'Not Executed' ? null : user.id, params.id);
  }
  return { ok: true };
});

route('DELETE', '/api/executions/:id', ({ params }) => tx(() => {
  deleteStepAttachments('e.id=?', params.id);
  q('DELETE FROM executions WHERE id=?').run(params.id);
  return { ok: true };
}));

route('PUT', '/api/step-results/:id', ({ params, body, user }) => {
  const sr = need(q('SELECT id, execution_id FROM step_results WHERE id=?').get(params.id), 'Step');
  return tx(() => {
    if (body.actual !== undefined) q('UPDATE step_results SET actual=? WHERE id=?').run(str(body.actual), sr.id);
    if (body.status !== undefined) {
      if (!STEP_STATUS.includes(body.status)) throw new HttpError(400, 'Invalid status');
      q('UPDATE step_results SET status=? WHERE id=?').run(body.status, sr.id);
      rollup(sr.execution_id, user.id);
    }
    return { ok: true };
  });
});

route('POST', '/api/step-results/:id/attachments', ({ params, body }) => {
  need(q('SELECT 1 FROM step_results WHERE id=?').get(params.id), 'Step');
  return saveAttachment('step', params.id, body);
});

// The headline feature: turn a failed step into a bug report in one request.
// Expected / actual / screenshots come from the step; the client may override any field.
route('POST', '/api/step-results/:id/bug', ({ params, body, user }) => {
  const sr = need(q(`SELECT sr.*, e.case_id, e.case_key, e.case_title, c.key AS cycle_key, c.project_id, c.environment, c.build
    FROM step_results sr JOIN executions e ON e.id=sr.execution_id JOIN cycles c ON c.id=e.cycle_id WHERE sr.id=?`).get(params.id), 'Step');
  const title = str(body.title).trim() || `${sr.case_key} step ${sr.position} failed: ${sr.case_title}`;
  const severity = str(body.severity, 'Major'), priority = str(body.priority, 'Medium');
  checkEnum('bugs', 'severity', severity); checkEnum('bugs', 'priority', priority);
  const env = body.environment !== undefined ? str(body.environment)
    : [sr.environment, sr.build && `Build ${sr.build}`].filter(Boolean).join(' · ');
  return tx(() => {
    const key = nextKey(sr.project_id, 'bug');
    const t = now();
    const id = Number(q(`INSERT INTO bugs(project_id, key, title, severity, priority, environment, expected, actual, steps_to_reproduce,
        case_id, execution_id, step_result_id, case_key, cycle_key, step_no, created_at, updated_at, reported_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sr.project_id, key, title.slice(0, 300), severity, priority, env,
      body.expected !== undefined ? str(body.expected) : sr.expected,
      body.actual !== undefined ? str(body.actual) : sr.actual,
      str(body.steps_to_reproduce), sr.case_id, sr.execution_id, sr.id, sr.case_key, sr.cycle_key, sr.position, t, t, user.id).lastInsertRowid);
    // Copy (not move) screenshots so the run keeps its own evidence.
    const copy = q(`INSERT INTO attachments(owner_type, owner_id, filename, mime, size, data, created_at)
      SELECT 'bug', ?, filename, mime, size, data, ? FROM attachments WHERE id=? AND owner_type='step' AND owner_id=?`);
    const ids = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(Number)
      : attachmentsOf('step', sr.id).map((a) => a.id);
    for (const aid of ids) copy.run(id, t, aid, sr.id);
    return { id, key };
  });
});

// --- bugs ---
route('GET', '/api/projects/:pid/bugs', ({ params }) =>
  q(`SELECT b.id, b.key, b.title, b.status, b.severity, b.priority, b.case_key, b.cycle_key, b.step_no, b.created_at, b.assignee_id,
      (SELECT display_name FROM users WHERE id=b.assignee_id) AS assignee_name,
      (SELECT COUNT(*) FROM attachments a WHERE a.owner_type='bug' AND a.owner_id=b.id) AS shots
     FROM bugs b WHERE b.project_id=? ORDER BY b.id DESC`).all(params.pid));

route('POST', '/api/projects/:pid/bugs', ({ params, body, user }) => {
  const title = str(body.title).trim();
  if (!title) throw new HttpError(400, 'Title is required');
  const severity = str(body.severity, 'Major'), priority = str(body.priority, 'Medium');
  checkEnum('bugs', 'severity', severity); checkEnum('bugs', 'priority', priority);
  return tx(() => {
    const key = nextKey(params.pid, 'bug');
    const t = now();
    const id = Number(q(`INSERT INTO bugs(project_id, key, title, severity, priority, environment, expected, actual, steps_to_reproduce, created_at, updated_at, reported_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(params.pid, key, title.slice(0, 300), severity, priority, str(body.environment),
      str(body.expected), str(body.actual), str(body.steps_to_reproduce), t, t, user.id).lastInsertRowid);
    return { id, key };
  });
});

route('GET', '/api/bugs/:id', ({ params }) => {
  const b = need(q(`SELECT b.*, (SELECT display_name FROM users WHERE id=b.reported_by) AS reporter_name,
    (SELECT display_name FROM users WHERE id=b.assignee_id) AS assignee_name FROM bugs b WHERE b.id=?`).get(params.id), 'Bug');
  b.attachments = attachmentsOf('bug', b.id);
  b.links = q('SELECT kind, external_key, url, created_at FROM bug_links WHERE bug_id=? ORDER BY id').all(b.id);
  b.comments = q(`SELECT c.id, c.body, c.created_at, c.user_id, u.display_name AS author FROM bug_comments c
    LEFT JOIN users u ON u.id=c.user_id WHERE c.bug_id=? ORDER BY c.id`).all(b.id);
  return b;
});

route('POST', '/api/bugs/:id/comments', ({ params, body, user }) => {
  need(q('SELECT 1 FROM bugs WHERE id=?').get(params.id), 'Bug');
  const text = str(body.body).trim();
  if (!text) throw new HttpError(400, 'Comment is empty');
  if (text.length > 10000) throw new HttpError(400, 'Comment is too long');
  const id = Number(q('INSERT INTO bug_comments(bug_id, user_id, body, created_at) VALUES (?,?,?,?)').run(params.id, user.id, text, now()).lastInsertRowid);
  return { id };
});

route('DELETE', '/api/bug-comments/:id', ({ params, user }) => {
  const c = need(q('SELECT * FROM bug_comments WHERE id=?').get(params.id), 'Comment');
  if (c.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'You can only delete your own comments');
  q('DELETE FROM bug_comments WHERE id=?').run(c.id);
  return { ok: true };
});

route('PUT', '/api/bugs/:id', ({ params, body }) => {
  need(q('SELECT 1 FROM bugs WHERE id=?').get(params.id), 'Bug');
  if (body.title !== undefined && !str(body.title).trim()) throw new HttpError(400, 'Title is required');
  update('bugs', params.id, body, ['title', 'status', 'severity', 'priority', 'environment', 'expected', 'actual', 'steps_to_reproduce']);
  if (body.assignee_id !== undefined) q('UPDATE bugs SET assignee_id=?, updated_at=? WHERE id=?').run(assigneeOrNull(body.assignee_id), now(), params.id);
  return { ok: true };
});

route('DELETE', '/api/bugs/:id', ({ params }) => tx(() => {
  q("DELETE FROM attachments WHERE owner_type='bug' AND owner_id=?").run(params.id);
  q('DELETE FROM bugs WHERE id=?').run(params.id);
  return { ok: true };
}));

route('POST', '/api/bugs/:id/attachments', ({ params, body }) => {
  need(q('SELECT 1 FROM bugs WHERE id=?').get(params.id), 'Bug');
  return saveAttachment('bug', params.id, body);
});

// Replace an image in place (used by the screenshot annotator); id, owner and file name stay the same.
route('PUT', '/api/attachments/:id/content', ({ params, body }) => {
  const att = need(q('SELECT id, mime FROM attachments WHERE id=?').get(params.id), 'Attachment');
  if (!(FILE_TYPES[att.mime] || {}).image) throw new HttpError(400, 'Only images can be edited');
  const { mime, data } = checkUpload(body, { imageOnly: true });
  q('UPDATE attachments SET mime=?, size=?, data=? WHERE id=?').run(mime, data.length, data, att.id);
  return { ok: true };
});

route('DELETE', '/api/attachments/:id', ({ params }) => {
  q('DELETE FROM attachments WHERE id=?').run(params.id);
  return { ok: true };
});

// ---------- seed ----------
function seed() {
  if (q('SELECT COUNT(*) n FROM projects').get().n) return;
  tx(() => {
    const pid = Number(q('INSERT INTO projects(key, name, created_at) VALUES (?,?,?)').run('DEMO', 'Demo Shop', now()).lastInsertRowid);
    const mk = (title, folder, priority, precondition, steps) => {
      const key = nextKey(pid, 'case'); const t = now();
      const id = Number(q(`INSERT INTO cases(project_id, key, title, objective, precondition, priority, status, folder, labels, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(pid, key, title, '', precondition, priority, 'Approved', folder, 'smoke', t, t).lastInsertRowid);
      replaceSteps(id, steps.map(([action, test_data, expected]) => ({ action, test_data, expected })));
      return id;
    };
    const ids = [
      mk('Sign in with valid credentials', 'Authentication', 'High', 'A registered account exists.', [
        ['Open the sign-in page', '/login', 'Sign-in form with email and password fields is shown'],
        ['Enter email and password, then press Sign in', 'demo@example.com / correct password', 'User lands on the account dashboard'],
        ['Reload the page', '', 'User is still signed in'],
      ]),
      mk('Add item to cart', 'Checkout', 'High', 'User is signed in. Cart is empty.', [
        ['Open any product page', 'Blue mug', 'Product details and an "Add to cart" button are shown'],
        ['Press "Add to cart"', '', 'Cart badge shows 1'],
        ['Open the cart', '', 'Cart lists the product with quantity 1 and the correct price'],
      ]),
      mk('Apply discount code at checkout', 'Checkout', 'Medium', 'Cart contains at least one item.', [
        ['Go to checkout', '', 'Order summary is shown'],
        ['Enter a discount code and press Apply', 'WELCOME10', 'Total is reduced by 10% and the code is listed'],
        ['Remove the discount code', '', 'Total returns to the original amount'],
      ]),
    ];
    const ckey = nextKey(pid, 'cycle');
    const cid = Number(q('INSERT INTO cycles(project_id, key, name, description, environment, build, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(pid, ckey, 'Release 1.0 smoke test', '', 'Staging · Chrome', '1.0.0-rc1', now()).lastInsertRowid);
    addCasesToCycle(cid, pid, ids);
  });
}
seed();
versions.backfill(); // the demo cases created by seed() above

// ---------- feature modules ----------
const ctx = { route, q, tx, db, now, str, need, HttpError, Raw, nextKey, checkEnum, update, assigneeOrNull, normFolder, attachmentsOf, DATA_DIR, CYCLE_COUNTS, sendTable, links,
  snapshotCase, rollup, insertCase, saveAttachment, setAutomationKey, autoKeyTaken, planOrNull };
secret.init(DATA_DIR);
authRoutes.install(ctx);
require('./routes/integrations').install(ctx);
require('./routes/reports').install(ctx);
require('./routes/plans').install(ctx);
require('./routes/traceability').install(ctx);
tokens.install(ctx);
require('./routes/ci').install(ctx);

// ---------- http ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    }

    if (req.method === 'GET' && p === '/api/import/template.csv') {
      if (!authRoutes.userFromRequest(req)) throw new HttpError(401, 'Sign in required');
      return send(res, 200, '﻿' + importer.TEMPLATE, {
        'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="proofdeck-import-template.csv"',
      });
    }

    const att = req.method === 'GET' && /^\/api\/attachments\/(\d+)$/.exec(p);
    if (att) {
      if (!authRoutes.userFromRequest(req)) throw new HttpError(401, 'Sign in required');
      const a = need(q('SELECT filename, mime, data FROM attachments WHERE id=?').get(Number(att[1])), 'Attachment');
      const t = FILE_TYPES[a.mime] || {};
      const safe = a.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      return send(res, 200, Buffer.from(a.data), {
        'Content-Type': a.mime.startsWith('text/') ? `${a.mime}; charset=utf-8` : a.mime,
        'Content-Disposition': `${t.image || t.inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
        // Annotating replaces the bytes under the same address, so the browser must re-check each time.
        'Cache-Control': 'private, no-cache',
      });
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(p);
      if (!m) continue;
      // CI routes take an API token in a header and nothing else; every other route needs a signed-in user.
      let user = null, apiToken = null;
      if (r.opts.token) apiToken = tokens.authenticate(req);
      else {
        user = authRoutes.userFromRequest(req);
        if (!r.opts.public) {
          if (!user) throw new HttpError(401, 'Sign in required');
          if (r.opts.admin && user.role !== 'admin') throw new HttpError(403, 'Only admins can do this');
          if (req.method !== 'GET' && user.role === 'viewer' && !r.opts.viewer) throw new HttpError(403, 'Your account is read-only');
        }
      }
      if (apiToken && req.method !== 'GET' && req.method !== 'DELETE') {
        // A bearer token is not sent by browsers on their own, so there is no cross-site risk; just insist on the right body type.
        const wanted = r.opts.raw ? /^(application|text)\/(xml|plain)|^application\/octet-stream/i : /^application\/json/i;
        if (!wanted.test(req.headers['content-type'] || '')) throw new HttpError(415, r.opts.raw ? 'Content-Type must be application/xml (or text/xml)' : 'Content-Type must be application/json');
      } else if (req.method !== 'GET') {
        // Writes must come from this site (SameSite=Strict cookies already stop most cross-site requests) and be JSON.
        const origin = req.headers.origin;
        if (origin !== undefined) {
          let host = '';
          try { host = new URL(origin).host; } catch { /* null or malformed origin */ }
          if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
        }
        if (req.method !== 'DELETE' && !/^application\/json/i.test(req.headers['content-type'] || '')) {
          throw new HttpError(415, 'Content-Type must be application/json');
        }
      }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = Number(m[i + 1]); });
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : r.opts.raw ? await readRaw(req) : await readBody(req);
      const out = await r.handler({ params, body, query: url.searchParams, user, req, token: apiToken });
      if (out instanceof Raw) return send(res, 200, out.body, out.headers);
      return sendJson(res, 200, out);
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal server error' : e.message, ...(status !== 500 && e.extra ? e.extra : {}) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`Proofdeck running at http://${HOST}:${server.address().port}`));
