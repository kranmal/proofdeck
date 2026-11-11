'use strict';
// Test case version history. A version is a JSON snapshot of the content of a case (title, text fields, steps...).
// Folder and requirement links are organisational, not content, so changing them does not create a version.

module.exports = function makeVersions({ q, now, str, normFolder, replaceSteps, checkEnum, HttpError }) {
  const FIELDS = ['title', 'objective', 'precondition', 'priority', 'status', 'labels'];

  // Stable key order so equal content always serialises equally.
  function snapshotObject(caseId) {
    const c = q(`SELECT ${FIELDS.join(', ')}, params FROM cases WHERE id=?`).get(caseId);
    if (!c) return null;
    const { params, ...fields } = c;
    const steps = q('SELECT action, test_data, expected, call_case_id FROM steps WHERE case_id=? ORDER BY position').all(caseId)
      .map((s) => (s.call_case_id ? { call_case_id: s.call_case_id } : { action: s.action, test_data: s.test_data, expected: s.expected }));
    return { ...fields, ...(params ? { params } : {}), steps };
  }

  // Saves a new version unless the content equals the latest one. Returns the current version number.
  function recordVersion(caseId, userId, { note = '', at = now() } = {}) {
    const snap = snapshotObject(caseId);
    if (!snap) return null;
    const json = JSON.stringify(snap);
    const last = q('SELECT version, snapshot FROM case_versions WHERE case_id=? ORDER BY version DESC LIMIT 1').get(caseId);
    if (last && last.snapshot === json) return last.version;
    const version = (last ? last.version : 0) + 1;
    q('INSERT INTO case_versions(case_id, version, snapshot, author_id, created_at, note) VALUES (?,?,?,?,?,?)').run(caseId, version, json, userId, at, note);
    q('UPDATE cases SET version=? WHERE id=?').run(version, caseId);
    return version;
  }

  // Cases that existed before versioning get a version 1 from their current content.
  function backfill() {
    for (const c of q('SELECT id, created_by, updated_at FROM cases WHERE id NOT IN (SELECT case_id FROM case_versions)').all()) {
      recordVersion(c.id, c.created_by, { at: c.updated_at });
    }
  }

  function restoreVersion(caseId, version, userId) {
    const row = q('SELECT snapshot FROM case_versions WHERE case_id=? AND version=?').get(caseId, version);
    if (!row) throw new HttpError(404, 'Version not found');
    const s = JSON.parse(row.snapshot);
    checkEnum('cases', 'priority', s.priority);
    checkEnum('cases', 'status', s.status);
    q(`UPDATE cases SET ${FIELDS.map((f) => `${f}=?`).join(', ')}, params=?, updated_at=?, updated_by=? WHERE id=?`)
      .run(...FIELDS.map((f) => str(s[f])), str(s.params), now(), userId, caseId);
    // A step that called a case which has since been deleted cannot come back.
    replaceSteps(caseId, s.steps.filter((st) => !st.call_case_id || q('SELECT 1 FROM cases WHERE id=?').get(st.call_case_id)));
    return recordVersion(caseId, userId, { note: `Restored from v${version}` });
  }

  return { snapshotObject, recordVersion, backfill, restoreVersion };
};
