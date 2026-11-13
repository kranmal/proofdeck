'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const importer = require('../lib/import');

// Fixtures were written with xlwt and compared cell by cell with xlrd, an independent reader, when they were made.
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'xls', `${n}.xls`));

test('.xls: text, unicode, numbers of every storage kind, dates, booleans and formula results', () => {
  const r = importer.parseTable(fx('basic'));
  assert.equal(r.format, 'xls');
  assert.deepEqual(r.headers, ['Key', 'Name', 'Status', 'Priority', 'Folder', 'Test Script - Step', 'Test Script - Expected Result']);
  assert.deepEqual(r.rows[0].slice(0, 4), ['T-1', 'Login works', 'Approved', 'High']);
  assert.equal(r.rows[1][1], 'Ünïcödé — “quotes” ✓ 日本語', 'wide characters survive');
  assert.deepEqual(r.rows[2].slice(5), ['Second step of T-2', 'Also fine'], 'a continuation row keeps its empty leading cells');
  const nums = r.rows[3];
  assert.deepEqual(nums.slice(0, 6), ['12', '3.14159', '-7', '1234567.891', '0.3', '100000000000'], 'integers, floats, negatives and 0.1+0.2 as Excel shows it');
  assert.deepEqual(r.rows[4].slice(0, 2), ['2026-11-13', '2026-11-13 14:30'], 'dates are recognised from their number format');
  assert.deepEqual(r.rows[5].slice(0, 2), ['TRUE', 'FALSE']);
  assert.equal(r.rows[6][0], 'after a blank row');
  assert.deepEqual(r.rows[7].slice(0, 3), ['1', '2', '3'], 'runs of numbers');
  assert.equal(r.mapping.title, 1);
});

test('.xls: formula cells give the result Excel stored: number, text, boolean, error', () => {
  const r = importer.parseTable(fx('formulas'));
  assert.deepEqual(r.headers, ['Key', 'Name', 'Status', 'Priority']);
  assert.deepEqual(r.rows[0].slice(0, 4), ['42', 'ab', 'TRUE', '#DIV/0!']);
  assert.equal(r.rows[0][4], '21');
});

test('.xls: with several sheets it picks the one that looks like test cases, and any sheet can be asked for', () => {
  const r = importer.parseTable(fx('multisheet'));
  assert.deepEqual([r.sheets, r.sheet, r.rows[0][1]], [['Notes', 'Test cases'], 1, 'On the second sheet']);
  const first = importer.parseTable(fx('multisheet'), 0);
  assert.equal(first.headers[0], 'Read me first');
});

test('.xls: a large sheet whose shared strings span many records, and one string longer than a record', () => {
  const r = importer.parseTable(fx('big'));
  assert.equal(r.rows.length, 1501);
  assert.equal(r.rows[0][0], 'B-1');
  assert.equal(r.rows[1499][0], 'B-1500');
  assert.equal(r.rows[99][1], 'Case 100 wörd wörd 日本'.replace('wörd wörd ', 'wörd '.repeat(100 % 17)), 'mixed narrow and wide strings stay intact across record boundaries');
  assert.equal(r.rows[1500][1].length, 9000);
  assert.ok(/^L+$/.test(r.rows[1500][1]));
  for (const i of [0, 250, 777, 1498]) assert.equal(r.rows[i][6], `Expected ${i + 1}`);
});

test('.xls: a small file stored in the compound file\'s mini stream', () => {
  const r = importer.parseTable(fx('mini'));
  assert.deepEqual([r.headers, r.rows[0]], [['Key', 'Name', 'Status'], ['M-1', 'Tiny file', 'Draft']]);
});

test('.xls rows feed the normal import: mapping, cases, steps', () => {
  const r = importer.parseTable(fx('basic'));
  const built = importer.buildCases(r.rows, r.mapping);
  assert.equal(built.cases[0].title, 'Login works');
  assert.equal(built.cases[1].steps.length, 2, 'T-2 has its second step on the continuation row');
});

test('.xls: old Excel 5/95 files and damaged files are refused with a clear message, never a crash', () => {
  const old = Buffer.from(fx('basic'));
  // find the first BOF record in the workbook stream and downgrade its version
  const at = old.indexOf(Buffer.from([0x09, 0x08, 0x10, 0x00, 0x00, 0x06]));
  assert.ok(at > 0);
  old.writeUInt16LE(0x0500, at + 4);
  assert.throws(() => importer.parseTable(old), /Excel 5\/95/);
  assert.throws(() => importer.parseTable(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(600)])), importer.ImportError);

  // deterministic damage: truncations and flipped bytes must end in a result or an ImportError, not another exception or a hang
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (const name of ['basic', 'multisheet', 'mini', 'formulas']) {
    const good = fx(name);
    for (let i = 0; i < 60; i++) {
      const b = Buffer.from(good);
      if (i % 3 === 0) { try { importer.parseTable(b.subarray(0, 512 + rnd(b.length - 512))); } catch (e) { assert.ok(e instanceof importer.ImportError, `${name} truncated: ${e}`); } continue; }
      for (let k = 0; k < 8; k++) b[rnd(b.length)] = rnd(256);
      try { importer.parseTable(b); } catch (e) { assert.ok(e instanceof importer.ImportError, `${name} damaged: ${e}`); }
    }
  }
});
