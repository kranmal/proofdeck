'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { zip } = require('../lib/export');
const { startAdmin } = require('./helpers');

let ctx, a;
before(async () => { ctx = await startAdmin(); a = ctx.admin; });
after(() => ctx.server.stop());

const b64 = (x) => Buffer.from(x).toString('base64');
const parse = async (buf) => (await a.post('/api/import/parse', { data: Buffer.from(buf).toString('base64') })).data;
const importRows = (parsed, extra = {}) => a.post('/api/projects/1/import', { rows: parsed.rows, mapping: parsed.mapping, ...extra });
const caseByTitle = async (title) => {
  const hit = (await a.get('/api/projects/1/cases')).data.find((c) => c.title === title);
  return hit ? (await a.get(`/api/cases/${hit.id}`)).data : null;
};

// ---- a workbook shaped the way Excel writes them (hand-written SpreadsheetML, not produced by our own writer)
const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
function excelStyleWorkbook() {
  const shared = [
    '<si><t>ID</t></si>', '<si><t>Name</t></si>', '<si><t>Priority</t></si>', '<si><t>Step</t></si>', '<si><t>Expected Result</t></si>',
    '<si><t xml:space="preserve">  Padded title  </t></si>',
    '<si><r><rPr><b/><sz val="11"/></rPr><t xml:space="preserve">Rich </t></r><r><rPr><i/></rPr><t>title</t></r></si>',
    '<si><t>Open page &amp; wait</t><rPh sb="0" eb="4"><t>PHONETIC</t></rPh><phoneticPr fontId="1"/></si>',
    '<si><t xml:space="preserve">line one&#10;line two_x000D_</t></si>',
    '<si><t>High</t></si>', '<si><t>Unrelated note</t></si>',
  ];
  const sheet2 = `${X}<worksheet ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><dimension ref="A1:E4"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><cols><col min="1" max="5" width="18" customWidth="1"/></cols>
<sheetData>
<row r="1" spans="1:5" x14ac:dyDescent="0.25"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1" t="s"><v>2</v></c><c r="D1" s="1" t="s"><v>3</v></c><c r="E1" s="1" t="s"><v>4</v></c></row>
<row r="2" spans="1:5" x14ac:dyDescent="0.25"><c r="A2"><v>101</v></c><c r="B2" t="s"><v>6</v></c><c r="C2" t="s"><v>9</v></c><c r="D2" t="s"><v>7</v></c><c r="E2" t="str"><f>"Done"&amp;""</f><v>Done</v></c></row>
<row r="3" spans="1:5"><c r="A3" s="2"/><c r="D3" t="s"><v>8</v></c><c r="E3" t="b"><v>1</v></c></row>
<row r="4" spans="1:5"><c r="A4"><v>102</v></c><c r="B4" t="s"><v>5</v></c><c r="D4" t="inlineStr"><is><t>inline step</t></is></c><c r="E4" t="e"><v>#N/A</v></c></row>
</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  const sheet1 = `${X}<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>10</v></c></row><row r="2"><c r="A2"><v>3.14</v></c></row></sheetData></worksheet>`;
  return zip([
    { name: '[Content_Types].xml', data: `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>` },
    { name: 'xl/workbook.xml', data: `${X}<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Notes" sheetId="1" state="hidden" r:id="rId1"/><sheet name="Test Cases" sheetId="2" r:id="rId2"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: 'xl/sharedStrings.xml', data: `${X}<sst ${NS} count="${shared.length}" uniqueCount="${shared.length}">${shared.join('')}</sst>` },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1 },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2 },
  ]);
}

test('an Excel-style workbook: shared and rich strings, absolute rel targets, formula/boolean/error cells, hidden sheet', async () => {
  const parsed = await parse(excelStyleWorkbook());
  assert.deepEqual(parsed.sheets, ['Notes', 'Test Cases']);
  assert.equal(parsed.sheet, 1, 'the sheet that looks like test cases is chosen over the first (hidden) one');
  assert.deepEqual(parsed.headers, ['ID', 'Name', 'Priority', 'Step', 'Expected Result']);
  assert.deepEqual(parsed.rows, [
    ['101', 'Rich title', 'High', 'Open page & wait', 'Done'],
    ['', '', '', 'line one\nline two', 'TRUE'],
    ['102', 'Padded title', '', 'inline step', '#N/A'],
  ]);
  const notes = (await a.post('/api/import/parse', { data: Buffer.from(excelStyleWorkbook()).toString('base64'), sheet: 0 })).data;
  assert.deepEqual(notes.rows, [['3.14']], 'the other sheet is still reachable and numbers stay as written');
  const r = (await importRows(parsed)).data;
  assert.equal(r.created, 2);
  const rich = await caseByTitle('Rich title');
  assert.equal(rich.priority, 'High');
  assert.deepEqual(rich.steps.map((s) => s.action), ['Open page & wait', 'line one\nline two']);
  assert.equal(rich.steps[0].expected, 'Done');
  assert.ok(await caseByTitle('Padded title'), 'titles are trimmed');
});

// ---- a CSV laid out like a Zephyr Scale export
const ZEPHYR = [
  'Key,Name,Status,Precondition,Objective,Folder,Priority,Component,Labels,Owner,Estimated Time,Coverage (Issues),Coverage (Pages),Test Script (Step-by-Step) - Step,Test Script (Step-by-Step) - Test Data,Test Script (Step-by-Step) - Expected Result',
  'PROJ-T1,Login with valid credentials,Approved,<p>User exists</p>,<p>Verify login</p>,/Authentication/Login,Normal,Web,"smoke, regression",jdoe,00:05,"PROJ-12, PROJ-13",,<p>Open the <strong>login</strong> page</p>,<p>url: /login</p>,<p>Form is shown<br />with two fields</p>',
  ',,,,,,,,,,,,,<ul><li>Enter email</li><li>Press Sign in</li></ul>,jane@example.com,<p>Dashboard &amp; welcome banner</p>',
  'PROJ-T2,Logout,Draft,,,/Authentication,High,,,,,PROJ-14,,Click logout,,User is signed out',
].join('\r\n') + '\r\n';

test('Zephyr-style export: columns are recognised, issue coverage becomes requirement links, HTML can be stripped', async () => {
  const parsed = await parse(ZEPHYR);
  assert.equal(parsed.hasHtml, true);
  assert.deepEqual(Object.keys(parsed.mapping).sort(), ['action', 'expected', 'folder', 'key', 'labels', 'links', 'objective', 'precondition', 'priority', 'status', 'test_data', 'title']);
  assert.equal(parsed.headers[parsed.mapping.links], 'Coverage (Issues)');
  const raw = (await importRows(parsed, { dryRun: true })).data;
  assert.deepEqual([raw.cases, raw.steps, raw.created], [2, 3, 2]);
  assert.equal((await importRows(parsed, { stripHtml: true })).data.created, 2);
  const c = await caseByTitle('Login with valid credentials');
  assert.equal(c.folder, 'Authentication/Login');
  assert.equal(c.priority, 'Medium', '“Normal” is Medium here');
  assert.equal(c.status, 'Approved');
  assert.equal(c.precondition, 'User exists');
  assert.equal(c.objective, 'Verify login');
  assert.deepEqual(c.links.map((l) => l.ref), ['PROJ-12', 'PROJ-13']);
  assert.deepEqual(c.steps.map((s) => s.action), ['Open the login page', '- Enter email\n- Press Sign in']);
  assert.equal(c.steps[0].expected, 'Form is shown\nwith two fields');
  assert.equal(c.steps[1].expected, 'Dashboard & welcome banner');
  assert.equal((await caseByTitle('Logout')).links[0].ref, 'PROJ-14');
});

test('without stripping, HTML is kept as is; stripping never touches the ID column', async () => {
  const parsed = await parse(ZEPHYR.replace(/PROJ-T/g, 'Z-T'));
  await importRows(parsed, { stripHtml: false });
  const kept = (await a.get('/api/projects/1/cases')).data.filter((c) => c.title === 'Login with valid credentials');
  assert.equal(kept.length, 2);
  const raw = (await a.get(`/api/cases/${kept[1].id}`)).data;
  assert.equal(raw.precondition, '<p>User exists</p>');
});

// ---- update modes
test('update by ID touches only the mapped columns, keeps unmapped data, and records a version', async () => {
  const made = (await a.post('/api/projects/1/cases', { title: 'Original title', priority: 'High', status: 'Approved', folder: 'Keep', objective: 'Keep objective',
    labels: 'old', steps: [{ action: 'old step', expected: 'old result' }], links: [{ ref: 'OLD-1' }] })).data;
  const csv = `ID,Name,Labels,Step,Expected Result\n${made.key},Renamed by file,"new, labels",new step,new result\n`;
  const parsed = await parse(csv);
  const dry = (await importRows(parsed, { mode: 'update_id', dryRun: true })).data;
  assert.deepEqual([dry.created, dry.updated, dry.preview[0].action, dry.preview[0].target], [0, 1, 'update', made.key]);
  const before = (await a.get('/api/projects/1/cases')).data.length;
  const r = (await importRows(parsed, { mode: 'update_id' })).data;
  assert.deepEqual([r.created, r.updated, r.updatedKeys], [0, 1, [made.key]]);
  assert.equal((await a.get('/api/projects/1/cases')).data.length, before, 'nothing new was created');
  const c = (await a.get(`/api/cases/${made.id}`)).data;
  assert.equal(c.title, 'Renamed by file');
  assert.equal(c.labels, 'new, labels');
  assert.deepEqual(c.steps.map((s) => [s.action, s.expected]), [['new step', 'new result']]);
  assert.deepEqual([c.priority, c.status, c.folder, c.objective], ['High', 'Approved', 'Keep', 'Keep objective'], 'unmapped columns are left alone');
  assert.deepEqual(c.links.map((l) => l.ref), ['OLD-1'], 'links are only replaced when the file has a requirements column');
  const vs = (await a.get(`/api/cases/${made.id}/versions`)).data;
  assert.equal(vs[0].note, 'Updated by import');
  assert.equal(vs.length, 2);
});

test('an empty priority/status cell does not reset an existing case; a mapped requirements column replaces links; no steps keeps steps', async () => {
  const made = (await a.post('/api/projects/1/cases', { title: 'Keeps steps', priority: 'Low', status: 'Approved', steps: [{ action: 'stay', expected: 'put' }], links: [{ ref: 'A-1' }, { ref: 'A-2' }] })).data;
  const csv = `ID,Name,Priority,Status,Requirements\n${made.key},Keeps steps,,whatever,"B-1; B-2"\n`;
  const r = (await importRows(await parse(csv), { mode: 'update_id' })).data;
  assert.equal(r.updated, 1);
  const c = (await a.get(`/api/cases/${made.id}`)).data;
  assert.deepEqual([c.priority, c.status], ['Low', 'Approved'], 'blank or unknown values never overwrite');
  assert.deepEqual(c.steps.map((s) => s.action), ['stay'], 'a file with no steps keeps the existing ones');
  assert.deepEqual(c.links.map((l) => l.ref), ['B-1', 'B-2']);
});

test('unmatched IDs are created; matching by title and folder; several matches are skipped, not guessed', async () => {
  const csv = 'ID,Name,Folder,Step\nNOPE-T9,Brand new,Imports,do it\n';
  const created = (await importRows(await parse(csv), { mode: 'update_id' })).data;
  assert.deepEqual([created.created, created.updated], [1, 0], 'an ID that does not exist creates the case');

  const one = (await a.post('/api/projects/1/cases', { title: 'Match me', folder: 'Zone', priority: 'Low' })).data;
  const twinA = (await a.post('/api/projects/1/cases', { title: 'Twin', folder: 'Zone' })).data;
  await a.post('/api/projects/1/cases', { title: 'Twin', folder: 'Zone' });
  const file = 'Name,Folder,Priority,Step\nmatch ME,/Zone/,High,updated step\nTwin,Zone,High,x\nNo such,Zone,High,y\n';
  const parsed = await parse(file);
  const dry = (await importRows(parsed, { mode: 'update_title', dryRun: true })).data;
  assert.deepEqual([dry.created, dry.updated, dry.ambiguous], [1, 1, 1]);
  assert.deepEqual(dry.preview.map((p) => p.action), ['update', 'ambiguous', 'create']);
  const r = (await importRows(parsed, { mode: 'update_title' })).data;
  assert.deepEqual([r.created, r.updated, r.ambiguous], [1, 1, 1]);
  const c = (await a.get(`/api/cases/${one.id}`)).data;
  assert.deepEqual([c.priority, c.steps[0].action], ['High', 'updated step']);
  assert.equal((await a.get(`/api/cases/${twinA.id}`)).data.priority, 'Medium', 'ambiguous matches are untouched');
  assert.equal((await a.post('/api/projects/1/import', { rows: parsed.rows, mapping: parsed.mapping, mode: 'merge' })).status, 400);
});

test('the default still creates; exporting then importing in update mode is a no-op round trip', async () => {
  const csv = 'Name,Step\nDup me,a step\n';
  await importRows(await parse(csv));
  await importRows(await parse(csv));
  assert.equal((await a.get('/api/projects/1/cases')).data.filter((c) => c.title === 'Dup me').length, 2, 'create mode makes duplicates, as before');

  const made = (await a.post('/api/projects/1/cases', { title: 'Round trip', folder: 'RT', priority: 'High', labels: 'x', links: [{ ref: 'RT-1' }, { ref: 'RT-2' }],
    steps: [{ action: 'one', expected: '1' }, { action: 'two', expected: '2' }] })).data;
  const exported = (await a.get(`/api/projects/1/export?format=xlsx&ids=${made.id}`)).data;
  const parsed = await parse(exported);
  assert.ok(parsed.headers.includes('Requirements') && parsed.headers.includes('Automation Key'));
  const before = (await a.get(`/api/cases/${made.id}`)).data;
  const r = (await importRows(parsed, { mode: 'update_id' })).data;
  assert.deepEqual([r.created, r.updated], [0, 1]);
  const after2 = (await a.get(`/api/cases/${made.id}`)).data;
  assert.deepEqual(after2.steps.map((s) => [s.action, s.expected]), before.steps.map((s) => [s.action, s.expected]));
  assert.deepEqual(after2.links.map((l) => l.ref), ['RT-1', 'RT-2']);
  assert.equal((await a.get(`/api/cases/${made.id}/versions`)).data.length, 1, 'identical content makes no new version');
});

// ---- automation key
test('automation keys are unique per project, never copied by clone, and importable', async () => {
  const x = (await a.post('/api/projects/1/cases', { title: 'Auto X', automation_key: 'tests/x.spec.ts::works' })).data;
  const y = (await a.post('/api/projects/1/cases', { title: 'Auto Y' })).data;
  assert.equal((await a.post('/api/projects/1/cases', { title: 'Dup key', automation_key: 'tests/x.spec.ts::works' })).status, 409);
  assert.equal((await a.put(`/api/cases/${y.id}`, { automation_key: ' tests/x.spec.ts::works ' })).status, 409);
  assert.equal((await a.get(`/api/cases/${y.id}`)).data.automation_key, '', 'a refused save changes nothing');
  await a.ok('PUT', `/api/cases/${y.id}`, { automation_key: 'tests/y.spec.ts::works' });
  await a.ok('PUT', `/api/cases/${x.id}`, { automation_key: '' });
  await a.ok('PUT', `/api/cases/${y.id}`, { automation_key: 'tests/x.spec.ts::works' });
  assert.equal((await a.get('/api/projects/1/cases')).data.find((c) => c.id === y.id).automation_key, 'tests/x.spec.ts::works', 'the list carries it');
  const copy = (await a.post(`/api/cases/${y.id}/clone`)).data;
  assert.equal((await a.get(`/api/cases/${copy.id}`)).data.automation_key, '');
  const csv = 'Name,Automation Key,Step\nFrom file,tests/new.spec.ts::fine,s\nClashing,tests/x.spec.ts::works,s\n';
  const r = (await importRows(await parse(csv))).data;
  assert.deepEqual([r.created, r.keyConflicts], [2, 1], 'a clashing key is dropped, the case is still imported');
  assert.equal((await caseByTitle('From file')).automation_key, 'tests/new.spec.ts::fine');
  assert.equal((await caseByTitle('Clashing')).automation_key, '');
  const other = (await a.post('/api/projects', { name: 'Other', key: 'OTH' })).data;
  assert.equal((await a.post(`/api/projects/${other.id}/cases`, { title: 'Same key elsewhere', automation_key: 'tests/x.spec.ts::works' })).status, 200, 'unique per project only');
});
