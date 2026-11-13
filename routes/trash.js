'use strict';
// Trash: deleting a test case, cycle or bug first copies it (and everything that hangs off it) into the trash
// table as JSON, then deletes it as before. Nothing else in the app has to know about deleted rows. Restoring
// puts the rows back, with their old ids when those are still free and new ones when not.
//
// What is kept: the item, its steps/versions/links/comments/files/custom field values, and for a cycle its
// runs, step results and their files. What is not undone: other test cases that called a deleted case lose
// that step when it is deleted, and stay that way.

const DAYS = Math.max(1, Number(process.env.TRASH_DAYS) || 30);

const KINDS = {
  case: { table: 'cases', label: (r) => `${r.key} ${r.title}`, field: 'case' },
  cycle: { table: 'cycles', label: (r) => `${r.key} ${r.name}`, field: 'cycle' },
  bug: { table: 'bugs', label: (r) => `${r.key} ${r.title}`, field: 'bug' },
  execution: { table: 'executions', label: (r) => `Run of ${r.case_key} ${r.case_title}`, field: null },
};
// Rows that point at an owner by (type, id) instead of a foreign key.
const POLY = {
  cases: [{ table: 'attachments', type: 'case' }, { table: 'item_comments', type: 'case' }],
  bugs: [{ table: 'attachments', type: 'bug' }],
  executions: [{ table: 'attachments', type: 'execution' }, { table: 'item_comments', type: 'execution' }],
  step_results: [{ table: 'attachments', type: 'step' }],
};

function install(ctx) {
  const { route, q, tx, db, now, need, HttpError } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS trash (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT NOT NULL, deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL, deleted_at TEXT NOT NULL, payload TEXT NOT NULL
  )`);

  // Foreign keys, read from the database itself so new tables are picked up without touching this file.
  const fks = () => {
    const out = [];
    for (const { name } of q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      for (const f of q(`PRAGMA foreign_key_list(${name})`).all()) out.push({ table: name, col: f.from, to: f.table, toCol: f.to || 'id', onDelete: f.on_delete });
    }
    return out;
  };

  const pack = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Buffer.isBuffer(v) || v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : v]));
  const unpack = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v && typeof v === 'object' && '$b64' in v ? Buffer.from(v.$b64, 'base64') : v]));

  function capture(kind, id, user) {
    const spec = KINDS[kind];
    const root = need(q(`SELECT * FROM ${spec.table} WHERE id=?`).get(id), kind);
    const graph = fks();
    const rows = [], nulls = [];
    const walk = (table, row, poly) => {
      rows.push({ t: table, row: pack(row), ...(poly ? { poly } : {}) });
      for (const f of graph.filter((g) => g.to === table)) {
        const kids = q(`SELECT * FROM ${f.table} WHERE ${f.col}=?`).all(row[f.toCol]);
        if (f.onDelete === 'CASCADE') for (const k of kids) walk(f.table, k);
        else if (f.onDelete === 'SET NULL') for (const k of kids) nulls.push({ t: f.table, id: k.id, col: f.col, ref: table, old: row[f.toCol] });
      }
      for (const p of POLY[table] || []) {
        for (const k of q(`SELECT * FROM ${p.table} WHERE owner_type=? AND owner_id=?`).all(p.type, row.id)) walk(p.table, k, { col: 'owner_id', parent: table });
      }
      const fieldKind = Object.values(KINDS).find((k) => k.table === table);
      if (fieldKind && fieldKind.field) {
        for (const v of q('SELECT v.* FROM custom_values v JOIN custom_fields f ON f.id=v.field_id WHERE f.entity=? AND v.entity_id=?').all(fieldKind.field, row.id)) {
          rows.push({ t: 'custom_values', row: pack(v), poly: { col: 'entity_id', parent: table } });
        }
      }
    };
    walk(spec.table, root);
    const projectId = root.project_id !== undefined ? root.project_id : q('SELECT project_id FROM cycles WHERE id=?').get(root.cycle_id).project_id;
    return Number(q('INSERT INTO trash(kind, project_id, label, deleted_by, deleted_at, payload) VALUES (?,?,?,?,?,?)')
      .run(kind, projectId, spec.label(root).slice(0, 300), user ? user.id : null, now(), JSON.stringify({ root: { t: spec.table, id: root.id }, rows, nulls })).lastInsertRowid);
  }
  ctx.trash = { capture };

  function restore(item) {
    const data = JSON.parse(item.payload);
    const graph = fks();
    const map = {}; // table -> { oldId: newId }
    const colsOf = (t) => q(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const { t, row: packed, poly } of data.rows) {
      const row = unpack(packed);
      const cols = colsOf(t);
      for (const f of graph.filter((g) => g.table === t)) {
        if (row[f.col] == null) continue;
        const mapped = map[f.to] && map[f.to][row[f.col]];
        if (mapped !== undefined) row[f.col] = mapped;
        else if (!q(`SELECT 1 FROM ${f.to} WHERE ${f.toCol}=?`).get(row[f.col])) row[f.col] = null; // someone it pointed at is gone
      }
      if (poly && map[poly.parent] && map[poly.parent][row[poly.col]] !== undefined) row[poly.col] = map[poly.parent][row[poly.col]];
      const oldId = row.id;
      if (cols.includes('id') && oldId != null && q(`SELECT 1 FROM ${t} WHERE id=?`).get(oldId)) delete row.id; // id taken: get a new one
      if (t === 'custom_values' && !q('SELECT 1 FROM custom_fields WHERE id=?').get(row.field_id)) continue; // the field was removed
      const names = Object.keys(row);
      const info = q(`INSERT INTO ${t}(${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
      if (oldId != null) (map[t] = map[t] || {})[oldId] = row.id !== undefined ? row.id : Number(info.lastInsertRowid);
    }
    for (const n of data.nulls) { // things that pointed at it and were detached by the delete
      const newRef = map[n.ref] && map[n.ref][n.old];
      if (newRef !== undefined) q(`UPDATE ${n.t} SET ${n.col}=? WHERE id=? AND ${n.col} IS NULL`).run(newRef, n.id);
    }
    const newId = map[data.root.t][data.root.id];
    if (item.kind === 'case') {
      const c = q('SELECT project_id, folder FROM cases WHERE id=?').get(newId);
      const parts = c.folder ? c.folder.split('/') : [];
      parts.forEach((_, i) => q('INSERT OR IGNORE INTO folders(project_id, path) VALUES (?,?)').run(c.project_id, parts.slice(0, i + 1).join('/')));
    }
    return newId;
  }

  const purge = () => { q('DELETE FROM trash WHERE deleted_at < ?').run(new Date(Date.now() - DAYS * 86400000).toISOString()); };
  purge();
  setInterval(purge, 3600000).unref();

  route('GET', '/api/projects/:pid/trash', ({ params }) => ({
    days: DAYS,
    items: q(`SELECT t.id, t.kind, t.label, t.deleted_at, length(t.payload) AS size, (SELECT display_name FROM users WHERE id=t.deleted_by) AS deleted_by_name
      FROM trash t WHERE t.project_id=? ORDER BY t.id DESC`).all(params.pid),
  }));

  route('POST', '/api/trash/:id/restore', ({ params }) => {
    const item = need(q('SELECT * FROM trash WHERE id=?').get(params.id), 'Trash item');
    try {
      return tx(() => {
        const id = restore(item);
        q('DELETE FROM trash WHERE id=?').run(item.id);
        return { kind: item.kind, id };
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(409, `Could not restore ${item.label}: ${String(e.message).replace(/^.*constraint failed: /i, 'conflict with ') }`);
    }
  });

  route('DELETE', '/api/trash/:id', ({ params }) => { q('DELETE FROM trash WHERE id=?').run(params.id); return { ok: true }; }, { admin: true });
  route('DELETE', '/api/projects/:pid/trash', ({ params }) => ({ count: Number(q('DELETE FROM trash WHERE project_id=?').run(params.pid).changes) }), { admin: true });
}

module.exports = { install };
