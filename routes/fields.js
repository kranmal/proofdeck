'use strict';
// Custom fields: admins add extra fields to test cases, bugs and cycles; values are stored per record.
// Required is enforced when a request sends field values (automated paths such as CI bugs are never blocked).

const TYPES = ['text', 'number', 'select', 'checkbox', 'date'];
const ENTITIES = ['case', 'bug', 'cycle'];

function install(ctx) {
  const { route, q, tx, db, now, str, need, HttpError, fieldsApi } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_fields (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]',
      required INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id, entity, key)
    );
    CREATE TABLE IF NOT EXISTS custom_values (
      field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE, entity_id INTEGER NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(field_id, entity_id)
    );`);

  const view = (f) => ({ id: f.id, entity: f.entity, key: f.key, label: f.label, type: f.type, options: JSON.parse(f.options), required: !!f.required, archived: !!f.archived });
  const defs = (pid, entity, all = false) => q(`SELECT * FROM custom_fields WHERE project_id=? AND entity=? ${all ? '' : 'AND archived=0'} ORDER BY position, id`).all(pid, entity);

  function cleanValue(f, raw) {
    const v = raw === null || raw === undefined ? '' : raw;
    if (f.type === 'checkbox') return v === true || v === 1 || ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase()) ? '1' : '';
    const s = String(v).trim();
    if (!s) return '';
    if (f.type === 'number') { if (!Number.isFinite(Number(s))) throw new HttpError(400, `“${f.label}” must be a number`); return String(Number(s)); }
    if (f.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `“${f.label}” must be a date (YYYY-MM-DD)`); return s; }
    if (f.type === 'select') { if (!JSON.parse(f.options).includes(s)) throw new HttpError(400, `“${f.label}” must be one of: ${JSON.parse(f.options).join(', ')}`); return s; }
    return s.slice(0, 1000);
  }

  fieldsApi.read = (entity, id) => Object.fromEntries(q(`SELECT f.key, v.value FROM custom_values v JOIN custom_fields f ON f.id=v.field_id
    WHERE f.entity=? AND v.entity_id=? AND f.archived=0`).all(entity, id).map((r) => [r.key, r.value]));

  // input: { key: value }. Keys that are not defined fields are ignored. An empty value clears the field.
  fieldsApi.save = (pid, entity, id, input) => {
    if (input === undefined || input === null) return;
    if (typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Custom fields must be an object of key: value');
    for (const f of defs(pid, entity)) {
      const given = Object.prototype.hasOwnProperty.call(input, f.key);
      const value = given ? cleanValue(f, input[f.key]) : null;
      if (f.required && f.type !== 'checkbox' && (given ? value === '' : !q('SELECT 1 FROM custom_values WHERE field_id=? AND entity_id=?').get(f.id, id))) throw new HttpError(400, `“${f.label}” is required`);
      if (!given) continue;
      if (value === '') q('DELETE FROM custom_values WHERE field_id=? AND entity_id=?').run(f.id, id);
      else q('INSERT INTO custom_values(field_id, entity_id, value) VALUES (?,?,?) ON CONFLICT(field_id, entity_id) DO UPDATE SET value=excluded.value').run(f.id, id, value);
    }
  };
  fieldsApi.copy = (entity, from, to) => q(`INSERT INTO custom_values(field_id, entity_id, value) SELECT v.field_id, ?, v.value FROM custom_values v JOIN custom_fields f ON f.id=v.field_id WHERE f.entity=? AND v.entity_id=?`).run(to, entity, from);
  fieldsApi.remove = (entity, id) => q('DELETE FROM custom_values WHERE entity_id=? AND field_id IN (SELECT id FROM custom_fields WHERE entity=?)').run(id, entity);

  route('GET', '/api/projects/:pid/fields', ({ params, query, user }) => {
    const entity = query.get('entity');
    const all = query.get('all') && user.role === 'admin';
    const list = entity ? defs(params.pid, entity, all) : ENTITIES.flatMap((e) => defs(params.pid, e, all));
    return list.map(view);
  });

  const slug = (label) => str(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  function cleanDef(body, existing) {
    const label = body.label !== undefined ? str(body.label).trim().slice(0, 60) : existing.label;
    if (!label) throw new HttpError(400, 'Give the field a name');
    const type = existing ? existing.type : str(body.type);
    if (!TYPES.includes(type)) throw new HttpError(400, `Type must be one of: ${TYPES.join(', ')}`);
    let options = existing ? JSON.parse(existing.options) : [];
    if (body.options !== undefined) options = [...new Set((Array.isArray(body.options) ? body.options : str(body.options).split('\n')).map((o) => str(o).trim()).filter(Boolean))].slice(0, 50);
    if (type === 'select' && !options.length) throw new HttpError(400, 'A choice field needs at least one option');
    return { label, type, options: type === 'select' ? options : [] };
  }

  route('POST', '/api/projects/:pid/fields', ({ params, body }) => {
    need(q('SELECT 1 FROM projects WHERE id=?').get(params.pid), 'Project');
    if (!ENTITIES.includes(body.entity)) throw new HttpError(400, 'Choose whether the field is for test cases, bugs or cycles');
    const d = cleanDef(body, null);
    const key = slug(d.label);
    if (!key) throw new HttpError(400, 'The name needs letters or digits');
    if (q('SELECT 1 FROM custom_fields WHERE project_id=? AND entity=? AND key=?').get(params.pid, body.entity, key)) throw new HttpError(409, `There is already a field called “${d.label}” here`);
    const pos = q('SELECT COALESCE(MAX(position),0)+1 n FROM custom_fields WHERE project_id=? AND entity=?').get(params.pid, body.entity).n;
    const id = Number(q('INSERT INTO custom_fields(project_id, entity, key, label, type, options, required, position) VALUES (?,?,?,?,?,?,?,?)')
      .run(params.pid, body.entity, key, d.label, d.type, JSON.stringify(d.options), body.required ? 1 : 0, pos).lastInsertRowid);
    return { id, key };
  }, { admin: true });

  route('PUT', '/api/fields/:id', ({ params, body }) => {
    const f = need(q('SELECT * FROM custom_fields WHERE id=?').get(params.id), 'Field');
    const d = cleanDef(body, f);
    q('UPDATE custom_fields SET label=?, options=?, required=?, archived=? WHERE id=?').run(d.label, JSON.stringify(d.options),
      body.required === undefined ? f.required : body.required ? 1 : 0, body.archived === undefined ? f.archived : body.archived ? 1 : 0, f.id);
    if (body.position !== undefined && Number.isInteger(Number(body.position))) q('UPDATE custom_fields SET position=? WHERE id=?').run(Number(body.position), f.id);
    return { ok: true };
  }, { admin: true });

  route('DELETE', '/api/fields/:id', ({ params }) => { q('DELETE FROM custom_fields WHERE id=?').run(params.id); return { ok: true }; }, { admin: true });
}

module.exports = { install };
