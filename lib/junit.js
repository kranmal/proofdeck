'use strict';
// A small, dependency-free reader for JUnit XML reports (Jest, pytest, Playwright, Maven/Gradle, Go, ...).
// It reads <testcase> elements with regular expressions; it never resolves entities or DTDs beyond the five
// predefined ones and numeric references, so a hostile report cannot pull in files or expand recursively.

class JunitError extends Error {}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] !== '#') return ENT[e.toLowerCase()];
  const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
});
const text = (s) => decode(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, c) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))).trim();

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3]);
  return out;
}

const MAX_OUTPUT = 100 * 1024;

// keyMode "classname": automation key is "classname::name" (just the name when there is no classname).
// keyMode "name": the test name alone. When a test appears several times (retries), the last run wins.
function parseJunit(xml, { keyMode = 'classname' } = {}) {
  const src = String(xml).replace(/^﻿/, '');
  if (!/<testsuites?\b/i.test(src) || !/<testcase\b/i.test(src)) throw new JunitError('This does not look like a JUnit XML report (no <testsuite> with <testcase> elements)');
  const found = new Map();
  for (const m of src.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/gi)) {
    const a = attrs(m[1]);
    const name = (a.name || '').trim();
    if (!name) continue;
    const classname = (a.classname || '').trim();
    const body = m[2] || '';
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/i.exec(body);
    let status = 'Pass', message = '';
    if (fail) {
      status = 'Fail';
      const fa = attrs(fail[2]);
      const first = text(fail[3] || '').split(/\r?\n/).find((l) => l.trim()) || '';
      message = [fa.type, fa.message || first].filter(Boolean).join(': ').slice(0, 1000) || 'Test failed';
    } else if (/<skipped\b/i.test(body)) status = 'Skipped';
    let output = '';
    if (status === 'Fail') {
      const parts = [];
      for (const tag of ['system-out', 'system-err']) {
        const o = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(body);
        if (o && text(o[1])) parts.push(`--- ${tag} ---\n${text(o[1])}`);
      }
      const trace = fail && text(fail[3] || '');
      if (trace) parts.unshift(`--- failure ---\n${trace}`);
      output = parts.join('\n\n').slice(0, MAX_OUTPUT);
    }
    const key = (keyMode === 'name' || !classname ? name : `${classname}::${name}`).slice(0, 300);
    found.set(key, { automation_key: key, title: name.slice(0, 200), status, message, duration_ms: Math.round(parseFloat(a.time) * 1000) || 0, output });
  }
  if (!found.size) throw new JunitError('The report contains no test cases');
  return [...found.values()];
}

module.exports = { parseJunit, JunitError };
