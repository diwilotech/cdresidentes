// Escrituras genéricas de un negocio: validan los campos, fijan business_id desde la sesión
// y comprueban que toda referencia (property_id, unit_id…) pertenezca al mismo negocio.
import { HttpError } from './http.js';
import { tenantDb, uuid } from './db.js';

// Tabla a la que apunta cada columna de referencia.
const REFS = { property_id: 'properties', unit_id: 'units', amenity_id: 'amenities' };

// fields: { columna: (valor, body) => valorValidado }. partial = solo las columnas presentes en body.
export function pick(body, fields, { partial = false } = {}) {
  const out = {};
  for (const [k, fn] of Object.entries(fields)) {
    if (partial && !(k in body)) continue;
    out[k] = fn(body[k], body);
  }
  return out;
}

async function checkRefs(c, data) {
  const db = tenantDb(c);
  for (const [col, table] of Object.entries(REFS)) {
    if (data[col] == null) continue;
    const ok = await db.first(`SELECT 1 FROM ${table} WHERE business_id = ? AND id = ?`, c.businessId, data[col]);
    if (!ok) throw new HttpError(400, 'Referencia no encontrada en este negocio');
  }
}

export async function getRow(c, table, id, label = 'Registro') {
  const row = await tenantDb(c).first(`SELECT * FROM ${table} WHERE business_id = ? AND id = ?`, c.businessId, id);
  if (!row) throw new HttpError(404, `${label} no encontrado`);
  return row;
}

export async function insertRow(c, table, data) {
  await checkRefs(c, data);
  const id = uuid();
  const cols = ['id', 'business_id', ...Object.keys(data)];
  await tenantDb(c).run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    id, c.businessId, ...Object.values(data),
  );
  return id;
}

export async function updateRow(c, table, id, data, { touch = true } = {}) {
  await checkRefs(c, data);
  const keys = Object.keys(data);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`);
  if (touch) sets.push(`updated_at = datetime('now')`);
  const res = await tenantDb(c).run(
    `UPDATE ${table} SET ${sets.join(', ')} WHERE business_id = ? AND id = ?`,
    ...Object.values(data), c.businessId, id,
  );
  if (!res.meta.changes) throw new HttpError(404, 'Registro no encontrado');
}

export async function deleteRow(c, table, id) {
  const res = await tenantDb(c).run(`DELETE FROM ${table} WHERE business_id = ? AND id = ?`, c.businessId, id);
  if (!res.meta.changes) throw new HttpError(404, 'Registro no encontrado');
}

// Filtro opcional por conjunto (?property=<id>) sobre una columna; devuelve [sql, args].
export function propertyFilter(c, column = 'property_id') {
  const p = c.url.searchParams.get('property');
  return p ? [` AND ${column} = ?`, [p]] : ['', []];
}

// Búsqueda de texto (?q=) sobre varias columnas; devuelve [sql, args].
export function searchFilter(c, columns) {
  const q = (c.url.searchParams.get('q') || '').trim().slice(0, 80);
  if (!q) return ['', []];
  const like = `%${q.replace(/[%_]/g, '')}%`;
  return [` AND (${columns.map((col) => `${col} LIKE ?`).join(' OR ')})`, columns.map(() => like)];
}
