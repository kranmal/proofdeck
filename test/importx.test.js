'use strict';
// Excel date cells, and import/export of Gherkin scripts, data sets and "call test case" steps.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { zip } = require('../lib/export');
const { startAdmin } = require('./helpers');

let ctx, a;
before(async () => { ctx = await startAdmin(); a = ctx.admin; });
after(() => ctx.server.stop());

const parse = async (buf) => (await a.post('/api/import/parse', { data: Buffer.from(buf).toString('base64') })).data;
const importRows = (parsed, extra = {}) => a.post('/api/projects/1/import', { rows: parsed.rows, mapping: parsed.mapping, ...extra });
const caseByTitle = async (title) => {
  const hit = (await a.get('/api/projects/1/cases')).data.find((c) => c.title === title);
  return hit ? (await a.get(`/api/cases/${hit.id}`)).data : null;
};

const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// A workbook with a few number formats: 0 General, 1 date (builtin 14), 2 custom date-time, 3 time (builtin 20), 4 plain number "0.00", 5 custom text-ish format.
function workbook({ date1904 = false, cells }) {
  const styles = `${X}<styleSheet ${NS}><numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/><numFmt numFmtId="165" formatCode="0.00&quot; days&quot;"/><numFmt numFmtId="166" formatCode="[$-409]d\\ mmm\\ yyyy"/></numFmts>
<fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="20"/><xf numFmtId="2"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs></styleSheet>`;
  const rows = cells.map((r, i) => `<row r="${i + 1}">${r.map((c, j) => {
    const ref = `${String.fromCharCode(65 + j)}${i + 1}`;
    if (c.t === 's') return `<c r="${ref}" t="inlineStr"><is><t>${c.v}</t></is></c>`;
    return `<c r="${ref}"${c.s ? ` s="${c.s}"` : ''}${c.t ? ` t="${c.t}"` : ''}><v>${c.v}</v></c>`;
  }).join('')}</row>`).join('');
  return zip([
    { name: '[Content_Types].xml', data: `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>` },
    { name: 'xl/workbook.xml', data: `${X}<workbook ${NS} xmlns:r="${REL}"><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: `${X}<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>` },
  ]);
}
const s = (v) => ({ t: 's', v });
const n = (v, st = 0) => ({ v, s: st });

test('Excel date cells arrive as dates, not serial numbers; other numbers are left alone', async () => {
  const buf = workbook({ cells: [
    [s('Name'), s('Step'), s('Test Data')],
    [s('Dates'), n(45292, 1), n(45292.5, 2)],            // 2024-01-01, and noon of it
    [s('More'), n(0.75, 3), n(44927, 6)],                // 18:00, 2023-01-01 in a custom date format
    [s('Numbers'), n(45292, 0), n(45292, 4)],            // General and 0.00 stay numbers
    [s('Custom number'), n(3.5, 5), n(1, 1)],            // "0.00 days" is not a date; serial 1 is 1900-01-01
  ] });
  const p = await parse(buf);
  assert.deepEqual(p.rows.map((r) => r.slice(1)), [['2024-01-01', '2024-01-01 12:00'], ['18:00', '2023-01-01'], ['45292', '45292'], ['3.5', '1900-01-01']]);
});

test('the 1904 date system and Excel’s fake 29 February 1900 are handled', async () => {
  const mac = await parse(workbook({ date1904: true, cells: [[s('Name'), s('Step')], [s('x'), n(0, 1)], [s('y'), n(1000, 1)]] }));
  assert.equal(mac.rows[1][1], '1906-09-27');
  const early = await parse(workbook({ cells: [[s('Name'), s('Step')], [s('a'), n(59, 1)], [s('b'), n(61, 1)], [s('c'), n(2958465, 1)], [s('d'), n(99999999, 1)]] }));
  assert.deepEqual(early.rows.map((r) => r[1]), ['1900-02-28', '1900-03-01', '9999-12-31', '99999999']);
});

test('a data set, a Gherkin script and call steps survive an export and an import', async () => {
  const lib = (await a.post('/api/projects/1/cases', { title: 'Shared login', steps: [{ action: 'Sign in', expected: 'Dashboard' }] })).data;
  const caller = (await a.post('/api/projects/1/cases', { title: 'Uses login', steps: [{ call_case_id: lib.id }, { action: 'Open reports', expected: 'Reports shown' }],
    params: { columns: ['user', 'role'], rows: [['ann', 'admin'], ['bob', 'viewer']] } })).data;
  const bdd = (await a.post('/api/projects/1/cases', { title: 'Gherkin one', script_type: 'bdd', bdd_script: 'Scenario: pay\n  Given a cart\n  When I pay\n  Then it works' })).data;

  const exported = (await a.get(`/api/projects/1/export?format=csv&ids=${lib.id},${caller.id},${bdd.id}`)).data;
  const parsed = await parse(exported);
  assert.ok(parsed.headers.includes('BDD Script') && parsed.headers.includes('Data Sets'));
  assert.ok(parsed.mapping.bdd_script >= 0 && parsed.mapping.params >= 0, 'the new columns are recognised by name');
  const callRow = parsed.rows.find((r) => /^Call test case/.test(r[parsed.mapping.action]));
  assert.ok(callRow, 'the call step is exported as text');

  // import into a fresh copy of the project's cases: create mode makes new cases, called case first
  const r = (await importRows(parsed, { mode: 'create' })).data;
  assert.equal(r.cases, 3);
  assert.equal(r.calls, 1);
  assert.equal(r.callsLinked, 1);
  assert.equal(r.callsUnresolved, 0);
  const all = (await a.get('/api/projects/1/cases')).data;
  const copies = {
    lib: all.filter((c) => c.title === 'Shared login').at(-1), caller: all.filter((c) => c.title === 'Uses login').at(-1), bdd: all.filter((c) => c.title === 'Gherkin one').at(-1),
  };
  const callerCopy = (await a.get(`/api/cases/${copies.caller.id}`)).data;
  assert.equal(callerCopy.steps[0].call_case_id, copies.lib.id, 'the copy calls the copied library case, not the original');
  assert.deepEqual(callerCopy.params, { columns: ['user', 'role'], rows: [['ann', 'admin'], ['bob', 'viewer']] });
  const bddCopy = (await a.get(`/api/cases/${copies.bdd.id}`)).data;
  assert.equal(bddCopy.script_type, 'bdd');
  assert.match(bddCopy.bdd_script, /Given a cart/);
});

test('a call to a case that exists in the project is linked; an unknown one stays as text and is reported', async () => {
  const lib = (await a.post('/api/projects/1/cases', { title: 'Existing helper', steps: [{ action: 'help', expected: 'ok' }] })).data;
  const csv = `Name,Step,Expected Result\nCaller A,Call test case ${lib.key}: Existing helper,\nCaller A,Press go,Went\nCaller B,Call test case ZZZ-T999,\n`;
  const r = (await importRows(await parse(csv))).data;
  assert.deepEqual([r.calls, r.callsLinked, r.callsUnresolved], [2, 1, 1]);
  const ca = await caseByTitle('Caller A');
  assert.equal(ca.steps[0].call_case_id, lib.id);
  assert.equal(ca.steps[1].action, 'Press go');
  const cb = await caseByTitle('Caller B');
  assert.equal(cb.steps[0].call_case_id, null);
  assert.match(cb.steps[0].action, /Call test case ZZZ-T999/);
});

test('calls that would loop are kept as text rather than failing the import', async () => {
  const x = (await a.post('/api/projects/1/cases', { title: 'Loop X', steps: [{ action: 'x', expected: 'x' }] })).data;
  const y = (await a.post('/api/projects/1/cases', { title: 'Loop Y', steps: [{ call_case_id: x.id }] })).data;
  // update X (matched by id) to call Y, which already calls X
  const csv = `ID,Name,Step\n${x.key},Loop X,Call test case ${y.key}\n`;
  const r = (await importRows(await parse(csv), { mode: 'update_id' })).data;
  assert.equal(r.updated, 1);
  assert.equal(r.callsUnresolved, 1);
  const after = (await a.get(`/api/cases/${x.id}`)).data;
  assert.equal(after.steps[0].call_case_id, null);
  assert.match(after.steps[0].action, /Call test case/);
});

test('bad data sets or Gherkin are reported by the preview, naming the test case, and nothing is imported', async () => {
  const before = (await a.get('/api/projects/1/cases')).data.length;
  const bad = async (header, cell) => importRows(await parse(`Name,Step,${header}\nBroken one,do it,${JSON.stringify(cell).replace(/^"|"$/g, '"')}\n`.replace(/\\"/g, '""')), { dryRun: true });
  const d = await bad('Data Sets', 'not json');
  assert.equal(d.status, 400);
  assert.match(d.data.error, /data sets of “Broken one”/);
  const tooMany = await importRows(await parse(`Name,Step,Data Sets\nBig,go,"{""columns"":[""bad name!""],""rows"":[]}"\n`), { dryRun: true });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /“Big”.*Column names/);
  const g = await importRows(await parse(`Name,BDD Script\nBad gherkin,"Scenario: x\n  Given a thing\n  nonsense"\n`), { dryRun: true });
  assert.equal(g.status, 400);
  assert.match(g.data.error, /“Bad gherkin”.*Gherkin script has a problem: line 3/);
  assert.equal((await a.get('/api/projects/1/cases')).data.length, before);
  const ok = await importRows(await parse(`Name,BDD Script,Data Sets\nGood,"Scenario: ok\n  Given a\n  Then b","{""columns"":[""v""],""rows"":[[""1""]]}"\n`), { dryRun: true });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.withBdd, ok.data.withDataSets], [1, 1]);
});

test('updating by id replaces data sets and the script only when those columns are in the file', async () => {
  const c = (await a.post('/api/projects/1/cases', { title: 'Keep me', steps: [{ action: 'a', expected: 'b' }], params: { columns: ['k'], rows: [['v']] } })).data;
  const without = await importRows(await parse(`ID,Name,Step\n${c.key},Keep me,a changed step\n`), { mode: 'update_id' });
  assert.equal(without.status, 200);
  assert.deepEqual((await a.get(`/api/cases/${c.id}`)).data.params, { columns: ['k'], rows: [['v']] }, 'data sets untouched without the column');
  const withCol = await importRows(await parse(`ID,Name,Data Sets\n${c.key},Keep me,"{""columns"":[""k""],""rows"":[[""x""],[""y""]]}"\n`), { mode: 'update_id' });
  assert.equal(withCol.status, 200, JSON.stringify(withCol.data));
  assert.deepEqual((await a.get(`/api/cases/${c.id}`)).data.params.rows, [['x'], ['y']]);
  assert.equal((await a.get(`/api/cases/${c.id}`)).data.steps[0].action, 'a changed step', 'steps untouched when the file has none');
});
