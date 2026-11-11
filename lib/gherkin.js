'use strict';
// A small Gherkin reader for one scenario per test case. It turns the script into the steps a tester executes
// and, for a Scenario Outline, the data set (Examples table); <placeholders> become {{placeholders}}.

const STEP = /^(Given|When|Then|And|But|\*)\s+(.*)$/i;
const SCENARIO = /^(Scenario Outline|Scenario Template|Scenario|Example)\s*:\s*(.*)$/i;

function cells(line) { return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()); }

function parseGherkin(text) {
  const errors = [];
  const out = { feature: '', background: [], scenario: null, outline: false, examples: null, errors };
  const lines = String(text || '').split(/\r?\n/);
  let mode = null, target = null, doc = null, scenarios = 0, exampleBlocks = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], line = raw.trim(), at = `line ${i + 1}`;
    if (doc !== null) {
      if (line === '"""' || line === '```') { target.text += `\n${doc.join('\n')}`; doc = null; } else doc.push(raw.replace(/^\s{0,8}/, ''));
      continue;
    }
    if (!line || line.startsWith('#') || /^@\S/.test(line)) continue;
    let m;
    if (/^Feature\s*:/i.test(line)) { out.feature = line.replace(/^Feature\s*:/i, '').trim(); mode = 'feature'; continue; }
    if (/^Background\s*:/i.test(line)) { mode = 'background'; target = null; continue; }
    if ((m = SCENARIO.exec(line))) {
      scenarios++;
      if (scenarios > 1) { errors.push(`${at}: a test case holds one scenario. Put each scenario in its own test case.`); break; }
      out.scenario = { name: m[2].trim(), steps: [] };
      out.outline = /outline|template/i.test(m[1]);
      mode = 'scenario'; target = null; continue;
    }
    if (/^(Examples|Scenarios)\s*:/i.test(line)) {
      if (!out.outline) errors.push(`${at}: Examples only belong under a Scenario Outline.`);
      exampleBlocks.push({ rows: [] }); mode = 'examples'; continue;
    }
    if (mode === 'examples') {
      if (line.startsWith('|')) exampleBlocks[exampleBlocks.length - 1].rows.push(cells(line));
      else errors.push(`${at}: expected a table row starting with | under Examples.`);
      continue;
    }
    if ((m = STEP.exec(line))) {
      if (mode !== 'scenario' && mode !== 'background') { errors.push(`${at}: a step must be inside a Scenario or Background.`); continue; }
      target = { keyword: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), text: m[2].trim() };
      if (target.keyword === '*') target.keyword = 'Step';
      (mode === 'background' ? out.background : out.scenario.steps).push(target);
      continue;
    }
    if (line.startsWith('|') && target) { target.text += `\n${line}`; continue; }
    if (line === '"""' || line === '```') { if (!target) errors.push(`${at}: a doc string must follow a step.`); else doc = []; continue; }
    if (mode === 'feature') continue; // free-text description under Feature
    errors.push(`${at}: I could not read “${line.slice(0, 60)}”. Steps start with Given, When, Then, And or But.`);
  }
  if (doc !== null) errors.push('A doc string was never closed.');
  if (!out.scenario && !errors.length) errors.push('Write a Scenario: with Given / When / Then steps.');
  if (out.scenario && !out.scenario.steps.length && !errors.length) errors.push('The scenario has no steps.');

  if (out.outline && !errors.length) {
    const blocks = exampleBlocks.filter((b) => b.rows.length);
    if (!blocks.length) errors.push('A Scenario Outline needs an Examples table with a header row and at least one data row.');
    else {
      const columns = blocks[0].rows[0];
      for (const b of blocks) {
        if (b.rows.length < 2) errors.push('An Examples table needs a header row and at least one data row.');
        else if (b.rows[0].join('|') !== columns.join('|')) errors.push('All Examples tables must have the same columns.');
        else if (b.rows.some((r) => r.length !== columns.length)) errors.push('A row in the Examples table has a different number of cells than its header.');
      }
      out.examples = { columns, rows: blocks.flatMap((b) => b.rows.slice(1)) };
      const used = new Set([...out.background, ...out.scenario.steps].flatMap((s) => [...s.text.matchAll(/<([^<>]+)>/g)].map((x) => x[1].trim())));
      for (const u of used) if (!columns.some((c) => c.toLowerCase() === u.toLowerCase())) errors.push(`The step uses <${u}> but the Examples table has no such column.`);
    }
  }
  return out;
}

// Steps in execution order, with <name> turned into {{name}} so the data-set substitution fills them in.
function gherkinSteps(parsed) {
  const conv = (t) => t.replace(/<([^<>]+)>/g, (m, n) => `{{${n.trim()}}}`);
  return [...parsed.background, ...(parsed.scenario ? parsed.scenario.steps : [])].map((s) => ({ action: `${s.keyword} ${conv(s.text)}`, test_data: '', expected: '' }));
}

module.exports = { parseGherkin, gherkinSteps };
