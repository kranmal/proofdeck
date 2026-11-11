'use strict';
// Spreadsheet export: CSV and a dependency-free .xlsx writer (zip container + SpreadsheetML).
// The test case layout (one row per step) is exactly what lib/import.js reads, so exports round-trip.

const zlib = require('node:zlib');

// ---------- CSV ----------
// Cells that start with = + - @ (or tab/CR) are prefixed with ' so Excel never runs them as formulas.
// lib/import.js strips that prefix again.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

// ---------- XLSX ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const xml = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function toXlsx(rows, { sheetName = 'Sheet1', widths = [] } = {}) {
  const name = String(sheetName).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet1';
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const sheetData = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (v === '' || v == null ? '' :
    `<c r="${colName(c)}${r + 1}" t="inlineStr" s="${r === 0 ? 1 : 2}"><is><t xml:space="preserve">${xml(String(v).slice(0, 32767))}</t></is></c>`)).join('')}</row>`).join('');
  const sheet = `${HEAD}<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${sheetData}</sheetData></worksheet>`;
  const styles = `${HEAD}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8ECF8"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return zip([
    { name: '[Content_Types].xml', data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${HEAD}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="${xml(name).replace(/"/g, '&quot;')}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

// ---------- row layouts ----------
const CASE_HEADERS = ['ID', 'Name', 'Objective', 'Precondition', 'Folder', 'Priority', 'Status', 'Labels', 'Step', 'Test Data', 'Expected Result'];
const CASE_WIDTHS = [12, 34, 30, 30, 22, 10, 12, 16, 44, 24, 44];

// cases: [{ key, title, objective, precondition, folder, priority, status, labels, steps: [{action, test_data, expected}] }]
function caseRows(cases) {
  const rows = [CASE_HEADERS];
  for (const c of cases) {
    const head = [c.key, c.title, c.objective, c.precondition, c.folder, c.priority, c.status, c.labels];
    if (!c.steps.length) { rows.push([...head, '', '', '']); continue; }
    c.steps.forEach((s, i) => rows.push([...(i === 0 ? head : head.map(() => '')), s.action, s.test_data, s.expected]));
  }
  return rows;
}

const RESULT_HEADERS = ['Cycle', 'Environment', 'Build', 'Test Case ID', 'Test Case', 'Execution Status', 'Executed', 'Step', 'Action', 'Test Data',
  'Expected Result', 'Actual Result', 'Step Status', 'Bugs'];
const RESULT_WIDTHS = [26, 20, 14, 12, 34, 16, 20, 6, 40, 22, 40, 40, 14, 18];

// cycle: row from cycles; execs: [{ ...execution, steps: [{position, action, test_data, expected, actual, status, bugs:[key]}], bugs:[key] }]
function resultRows(cycle, execs) {
  const rows = [RESULT_HEADERS];
  const lead = (e) => [`${cycle.key} ${cycle.name}`, cycle.environment, cycle.build, e.case_key, e.case_title, e.status, e.executed_at || ''];
  for (const e of execs) {
    if (!e.steps.length) { rows.push([...lead(e), '', '', '', '', '', e.status, e.bugs.join(', ')]); continue; }
    for (const s of e.steps) rows.push([...lead(e), s.position, s.action, s.test_data, s.expected, s.actual, s.status, s.bugs.join(', ')]);
  }
  return rows;
}

module.exports = { toCsv, toXlsx, caseRows, resultRows, CASE_WIDTHS, RESULT_WIDTHS };
