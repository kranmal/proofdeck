'use strict';
// Requirement links: a test case can point at the requirements (Jira issues, GitHub issues, anything) it covers.

module.exports = function makeLinks({ q, str, HttpError }) {
  const MAX_LINKS = 30;

  function clean(input) {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw new HttpError(400, 'Requirement links must be a list');
    const seen = new Set(), out = [];
    for (const l of input) {
      const ref = str(l && l.ref).trim().slice(0, 100);
      if (!ref || seen.has(ref.toLowerCase())) continue;
      seen.add(ref.toLowerCase());
      const url = str(l.url).trim();
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new HttpError(400, `The link for ${ref} must start with http:// or https://`);
      out.push({ ref, title: str(l.title).trim().slice(0, 200), url: url.slice(0, 500) });
    }
    if (out.length > MAX_LINKS) throw new HttpError(400, `At most ${MAX_LINKS} requirements per test case`);
    return out;
  }

  function replaceLinks(caseId, input) {
    const list = clean(input);
    q('DELETE FROM case_links WHERE case_id=?').run(caseId);
    const ins = q('INSERT INTO case_links(case_id, ref, title, url) VALUES (?,?,?,?)');
    for (const l of list) ins.run(caseId, l.ref, l.title, l.url);
  }

  function copyLinks(from, to) {
    q('INSERT INTO case_links(case_id, ref, title, url) SELECT ?, ref, title, url FROM case_links WHERE case_id=?').run(to, from);
  }

  // The address to open for a link: its own URL, else built from the project's Jira / GitHub connection.
  function hrefFor(projectId, l) {
    if (l.url) return l.url;
    const cfg = (kind) => { const r = q('SELECT config FROM integrations WHERE project_id=? AND kind=?').get(projectId, kind); return r ? JSON.parse(r.config) : null; };
    if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(l.ref)) {
      const j = cfg('jira');
      if (j) return `${j.base}/browse/${l.ref.toUpperCase()}`;
    }
    const m = /^#(\d+)$/.exec(l.ref);
    const g = m && cfg('github');
    if (g) return `${g.base.replace(/\/api\/v3$/, '').replace('//api.github.com', '//github.com')}/${g.owner}/${g.repo}/issues/${m[1]}`;
    return '';
  }

  function linksOf(c) {
    return q('SELECT ref, title, url FROM case_links WHERE case_id=? ORDER BY id').all(c.id).map((l) => ({ ...l, href: hrefFor(c.project_id, l) }));
  }

  return { clean, replaceLinks, copyLinks, hrefFor, linksOf };
};
