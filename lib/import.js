'use strict';
// Spreadsheet import: reads CSV/TSV and .xlsx without dependencies and turns
// "one row per step" tables (the layout Zephyr Scale and most tools export) into test cases.

const zlib = require('node:zlib');

const MAX_ROWS = 10000;
const MAX_UNZIPPED = 150 * 1024 * 1024;

class ImportError extends Error {}

// ---------- CSV ----------
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === '\n' || ch === '\r')) break;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

function parseCsv(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"' && field === '') inQ = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- XLSX (zip of XML) ----------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ImportError('File is not a valid .xlsx workbook');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ImportError('Corrupt .xlsx file');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  let budget = MAX_UNZIPPED;
  return {
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const raw = buf.subarray(start, start + e.compSize);
      let out;
      if (e.method === 0) out = raw;
      else if (e.method === 8) {
        try { out = zlib.inflateRawSync(raw, { maxOutputLength: budget }); }
        catch { throw new ImportError('Workbook is too large or corrupt'); }
      } else throw new ImportError('Unsupported compression in .xlsx file');
      budget -= out.length;
      if (budget < 0) throw new ImportError('Workbook is too large');
      return out.toString('utf8');
    },
  };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => (e[0] === '#'
    ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ENT[e.toLowerCase()]))
  .replace(/_x000D_/g, '');
const attr = (tag, name) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : null; };
const richText = (xml) => {
  let out = '';
  for (const m of xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += unxml(m[1] || '');
  return out;
};
const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); }
  return n - 1;
};

// ---- Excel stores dates as serial numbers; a cell is a date only because of its number format.
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function isDateCode(code) {
  const c = String(code).replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[dmyhs]/i.test(c) && !/^general$/i.test(c.trim());
}
// xf index -> true when that cell style formats a date or time
function dateStyles(zip) {
  const st = zip.read('xl/styles.xml');
  const out = [];
  if (!st) return out;
  const custom = new Map();
  for (const m of st.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), unxml(attr(m[0], 'formatCode') || ''));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st);
  if (!xfs) return out;
  for (const m of xfs[1].matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId')) || 0;
    out.push(custom.has(id) ? isDateCode(custom.get(id)) : BUILTIN_DATE_FMT.has(id));
  }
  return out;
}
const pad2 = (n) => String(n).padStart(2, '0');
function serialToText(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null;
  const whole = Math.floor(serial);
  const secs = Math.round((serial - whole) * 86400);
  const hms = `${pad2(Math.floor(secs / 3600) % 24)}:${pad2(Math.floor(secs / 60) % 60)}${secs % 60 ? `:${pad2(secs % 60)}` : ''}`;
  if (whole === 0) return hms;                        // a time of day on its own
  // 1900 system: serial 1 is 1900-01-01 and Excel wrongly has a 29 Feb 1900, so days before 61 are shifted by one.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : whole < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + whole * 86400000);
  const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return secs ? `${day} ${hms}` : day;
}

function parseXlsx(buf, sheetIdx) {
  const zip = unzip(buf);
  const wb = zip.read('xl/workbook.xml');
  if (!wb) throw new ImportError('File is not an Excel workbook');
  const rels = zip.read('xl/_rels/workbook.xml.rels') || '';
  const targets = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) targets.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m, i) => {
    const target = targets.get(attr(m[0], 'r:id')) || `worksheets/sheet${i + 1}.xml`;
    return { name: attr(m[0], 'name') || `Sheet ${i + 1}`, path: target.startsWith('/') ? target.slice(1) : `xl/${target}` };
  }).filter((s) => zip.has(s.path));
  if (!sheets.length) throw new ImportError('Workbook has no worksheets');
  const sheet = Math.min(Math.max(Number(sheetIdx) || 0, 0), sheets.length - 1);

  const dateXf = dateStyles(zip);
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/i.test(wb);
  const shared = [];
  const sst = zip.read('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(richText(m[1] || ''));

  const rows = [];
  const xml = zip.read(sheets[sheet].path);
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    let next = 0;
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], 'r');
      const i = ref ? colIndex(ref) : next;
      next = i + 1;
      if (i < 0 || i > 500) continue;
      const type = attr(cm[1], 't');
      const inner = cm[2] || '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      let val = '';
      if (type === 'inlineStr') val = richText(inner);
      else if (v && type === 's') val = shared[Number(v[1])] ?? '';
      else if (v && type === 'b') val = v[1] === '1' ? 'TRUE' : 'FALSE';
      else if (v && type === 'd') val = unxml(v[1]).replace('T', ' ').replace(/ 00:00(:00)?(\.0+)?Z?$/, '').replace(/Z$/, '');
      else if (v && (!type || type === 'n') && dateXf[Number(attr(cm[1], 's'))]) val = serialToText(Number(v[1]), date1904) ?? unxml(v[1]);
      else if (v) val = unxml(v[1]);
      row[i] = val;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
    if (rows.length > MAX_ROWS + 1) break;
  }
  return { rows, sheets: sheets.map((s) => s.name), sheet };
}

// ---------- table -> headers + rows ----------
function parseTable(buf, sheetIdx) {
  if (!buf.length) throw new ImportError('File is empty');
  let rows, sheets = [], sheet = 0, format = 'csv';
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    ({ rows, sheets, sheet } = parseXlsx(buf, sheetIdx));
    format = 'xlsx';
    // No sheet chosen yet: prefer the first sheet that looks like a test case table.
    if (sheetIdx == null && sheets.length > 1) {
      for (let i = 0; i < sheets.length; i++) {
        const cand = i === sheet ? rows : parseXlsx(buf, i).rows;
        const head = cand.find((r) => r.some((c) => String(c).trim() !== ''));
        if (head && guessMapping(head.map((c) => String(c).trim())).title !== undefined) { rows = cand; sheet = i; break; }
      }
    }
  }
  else if (buf[0] === 0xd0 && buf[1] === 0xcf) throw new ImportError('Old .xls files are not supported. Save the sheet as .xlsx or CSV and try again.');
  else rows = parseCsv(decodeText(buf));

  // Exports prefix cells starting with = + - @ with ' to defuse spreadsheet formulas; undo that here.
  rows = rows.map((r) => r.map((c) => String(c).replace(/\r\n?/g, '\n').trim().replace(/^'(?=[=+\-@])/, ''))).filter((r) => r.some((c) => c !== ''));
  if (!rows.length) throw new ImportError(format === 'xlsx' ? 'The selected sheet is empty' : 'File has no rows');
  const headers = rows[0].map((h, i) => h || `Column ${i + 1}`);
  const data = rows.slice(1);
  const truncated = data.length > MAX_ROWS;
  return { format, sheets, sheet, headers, rows: truncated ? data.slice(0, MAX_ROWS) : data, truncated, mapping: guessMapping(headers), hasHtml: data.some((r) => r.some((c) => HTML_RE.test(c))) };
}

// Checked in order; each header is claimed by the first field that matches it.
const GUESS = [
  ['key', /^(key|id|test ?case ?(id|key)|case ?id)$/],
  ['title', /^(name|title|summary|test ?case( ?(name|title))?|test ?name)$/],
  ['action', /- step$|^(steps?|actions?|test ?steps?|step ?(description|action|details))$/],
  ['test_data', /test ?data|^data$/],
  ['expected', /expected/],
  ['precondition', /pre-?conditions?|pre-?requisites?/],
  ['priority', /priority/],
  ['status', /^status$/],
  ['folder', /folder|suite|section|module/],
  ['labels', /^(labels?|tags?)$/],
  ['links', /^(coverage \(issues\)|requirements?|linked issues?|issues?|links?)$/],
  ['automation_key', /^automation( ?(key|id))?$/],
  ['bdd_script', /^(bdd|gherkin)( ?(script|scenario))?$/],
  ['params', /^data ?sets?$/],
  ['objective', /objective|description/],
];
function guessMapping(headers) {
  const mapping = {};
  headers.forEach((h, i) => {
    const name = h.toLowerCase().replace(/\s+/g, ' ').trim();
    const hit = GUESS.find(([field, re]) => mapping[field] === undefined && re.test(name));
    if (hit) mapping[hit[0]] = i;
  });
  return mapping;
}

const PRIORITY = { highest: 'High', critical: 'High', blocker: 'High', urgent: 'High', high: 'High', p0: 'High', p1: 'High',
  medium: 'Medium', normal: 'Medium', major: 'Medium', p2: 'Medium', low: 'Low', lowest: 'Low', minor: 'Low', trivial: 'Low', p3: 'Low', p4: 'Low' };
const STATUS = { 'in review': 'In Review', review: 'In Review', draft: 'Draft', approved: 'Approved', active: 'Approved', ready: 'Approved', deprecated: 'Deprecated', obsolete: 'Deprecated', retired: 'Deprecated' };

// Zephyr Scale (and other tools with rich text editors) export HTML such as <p>, <br> and <li>.
const HTML_RE = /<\s*(br|p|div|ul|ol|li|strong|em|b|i|span|a|table|h[1-6])(\s[^>]*)?\/?>/i;
const stripHtml = (t) => String(t)
  .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const splitRefs = (v) => [...new Set(String(v).split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean))];

// A row with a title starts a test case; following rows with a blank (or repeated) title add steps to it.
// opts.stripHtml turns rich text into plain text. Besides the cases it reports which fields the file maps
// (an update only touches those) and, per case, whether priority/status were really given.
function buildCases(rows, mapping, opts = {}) {
  const m = mapping && typeof mapping === 'object' ? mapping : {};
  const raw = (r, f) => { const i = m[f]; return Number.isInteger(i) && i >= 0 && r[i] != null ? String(r[i]).trim() : ''; };
  const col = (r, f) => (opts.stripHtml && f !== 'key' ? stripHtml(raw(r, f)) : raw(r, f));
  if (!Number.isInteger(m.title) || m.title < 0) throw new ImportError('Choose which column holds the test case title');
  const cases = [];
  let cur = null, curKey = '', skipped = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(r)) continue;
    const title = col(r, 'title'), key = col(r, 'key');
    let isNew = false;
    if (title) {
      if (!cur) isNew = true;
      else if (key && curKey) isNew = key !== curKey;
      else isNew = title !== cur.title;
    }
    if (isNew) {
      const p = col(r, 'priority').toLowerCase(), st = col(r, 'status').toLowerCase();
      cur = {
        title: title.replace(/\s*\n\s*/g, ' ').slice(0, 200), objective: col(r, 'objective'), precondition: col(r, 'precondition'),
        priority: PRIORITY[p] || 'Medium', status: STATUS[st] || 'Draft',
        folder: col(r, 'folder').replace(/^\/+|\/+$/g, ''), labels: col(r, 'labels'), steps: [],
        key, links: splitRefs(col(r, 'links')).map((ref) => ({ ref })), automation_key: col(r, 'automation_key'),
        has: { priority: !!PRIORITY[p], status: !!STATUS[st] },
      };
      const script = raw(r, 'bdd_script');
      if (script) { cur.script_type = 'bdd'; cur.bdd_script = script; }
      const data = raw(r, 'params');
      if (data) {
        let p = null;
        try { p = JSON.parse(data); } catch { /* reported below */ }
        if (!p || !Array.isArray(p.columns) || !Array.isArray(p.rows)) throw new ImportError(`The data sets of “${cur.title}” must be JSON like {"columns":["user"],"rows":[["ann"],["bob"]]}`);
        cur.params = data;
      }
      curKey = key;
      cases.push(cur);
    }
    if (!cur) { skipped++; continue; }
    const step = { action: col(r, 'action'), test_data: col(r, 'test_data'), expected: col(r, 'expected') };
    const call = /^call (?:test ?)?case\s+([A-Za-z][A-Za-z0-9]{0,9}-T?\d+)\b/i.exec(step.action);
    if (call) { step.call = call[1].toUpperCase(); step.test_data = ''; step.expected = ''; }  // a reusable step: the called case's steps run here
    if (step.action || step.test_data || step.expected) cur.steps.push(step);
  }
  return { cases, skipped, mapped: Object.keys(m).filter((f) => Number.isInteger(m[f]) && m[f] >= 0) };
}

const TEMPLATE = [
  'Name,Objective,Precondition,Folder,Priority,Status,Labels,Step,Test Data,Expected Result',
  'Sign in with valid credentials,Registered users can sign in,A registered account exists,Authentication,High,Approved,smoke,Open the sign-in page,/login,Sign-in form is shown',
  ',,,,,,,"Enter email and password, then press Sign in",demo@example.com,User lands on the dashboard',
  'Reset password,Users can recover access,A registered account exists,Authentication,Medium,Draft,,"Press ""Forgot password""",,Reset form is shown',
  ',,,,,,,Submit the registered email,demo@example.com,Confirmation message is shown',
  '',
].join('\r\n');

module.exports = { parseTable, buildCases, guessMapping, ImportError, TEMPLATE };
