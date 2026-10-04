// Unidades privadas: directorio de copropietarios y arrendatarios.
import { json, readJson, str, num, email, oneOf, HttpError } from '../lib/http.js';
import { tenantDb } from '../lib/db.js';
import { pick, insertRow, updateRow, deleteRow, getRow, propertyFilter, searchFilter } from '../lib/crud.js';
import { CONCEPTS } from './charges.js';

export const UNIT_KINDS = ['apartamento', 'casa', 'local', 'penthouse', 'parqueadero', 'deposito'];

const FIELDS = {
  property_id: (v) => str(v, { required: true, max: 40, label: 'Conjunto' }),
  tower: (v) => str(v, { max: 40, label: 'Torre' }),
  number: (v) => str(v, { required: true, max: 20, label: 'Número' }),
  kind: (v) => oneOf(v, UNIT_KINDS, { label: 'Tipo', fallback: 'apartamento' }),
  area_m2: (v) => num(v, { min: 0, max: 100000, label: 'Área' }),
  coefficient: (v) => num(v, { min: 0, max: 100, label: 'Coeficiente' }),
  owner_name: (v) => str(v, { max: 120, label: 'Propietario' }),
  owner_doc: (v) => str(v, { max: 30, label: 'Documento' }),
  owner_phone: (v) => str(v, { max: 30, label: 'Celular' }),
  owner_email: (v) => email(v, { label: 'Correo del propietario' }),
  tenant_name: (v) => str(v, { max: 120, label: 'Arrendatario' }),
  tenant_phone: (v) => str(v, { max: 30, label: 'Celular del arrendatario' }),
  tenant_email: (v) => email(v, { label: 'Correo del arrendatario' }),
  occupancy: (v) => oneOf(v, ['owner', 'tenant', 'vacant'], { label: 'Ocupación', fallback: 'owner' }),
  residents: (v) => num(v, { min: 0, max: 50, label: 'Habitantes' }),
  vehicles: (v) => str(v, { max: 120, label: 'Vehículos' }),
  notes: (v) => str(v, { max: 2000, label: 'Notas' }),
};

// Nombre corto de la unidad: "Torre A · 402".
export const unitLabel = (u) => [u.tower, u.number].filter(Boolean).join(' · ');

// Unidad + saldo vencido (lo usan cartera, cobros y el asistente).
export const UNIT_DEBT_SQL = `
  SELECT u.*, p.name AS property_name,
         COALESCE((SELECT SUM(ch.amount) FROM charges ch WHERE ch.business_id = u.business_id AND ch.unit_id = u.id AND ch.paid_at IS NULL AND ch.due_date < date('now', '-5 hours')), 0) AS overdue,
         COALESCE((SELECT SUM(ch.amount) FROM charges ch WHERE ch.business_id = u.business_id AND ch.unit_id = u.id AND ch.paid_at IS NULL), 0) AS balance,
         (SELECT MIN(ch.due_date) FROM charges ch WHERE ch.business_id = u.business_id AND ch.unit_id = u.id AND ch.paid_at IS NULL AND ch.due_date < date('now', '-5 hours')) AS oldest_due
    FROM units u JOIN properties p ON p.id = u.property_id`;

const dupError = (err) => {
  if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe esa unidad en el conjunto');
  throw err;
};

export function routes(r) {
  r.get('/api/admin/units', 'tenant', async (c) => {
    const sp = c.url.searchParams;
    const [pf, pa] = propertyFilter(c, 'u.property_id');
    const [qf, qa] = searchFilter(c, ['u.number', 'u.tower', 'u.owner_name', 'u.tenant_name', 'u.owner_doc', 'u.owner_phone', 'u.vehicles']);
    let extra = '';
    const ea = [];
    if (sp.get('tower')) { extra += ' AND u.tower = ?'; ea.push(sp.get('tower')); }
    if (sp.get('kind')) { extra += ' AND u.kind = ?'; ea.push(sp.get('kind')); }
    let items = await tenantDb(c).all(
      `${UNIT_DEBT_SQL} WHERE u.business_id = ?${pf}${qf}${extra}
        ORDER BY p.name, u.tower, CAST(u.number AS INTEGER), u.number`,
      c.businessId, ...pa, ...qa, ...ea,
    );
    if (sp.get('debt') === '1') items = items.filter((u) => u.overdue > 0);
    if (sp.get('debt') === '0') items = items.filter((u) => u.overdue <= 0);
    const towers = [...new Set(items.map((u) => u.tower).filter(Boolean))].sort();
    return json({ items, towers });
  });

  r.get('/api/admin/units/:id', 'tenant', async (c) => {
    const db = tenantDb(c);
    const unit = await db.first(`${UNIT_DEBT_SQL} WHERE u.business_id = ? AND u.id = ?`, c.businessId, c.params.id);
    if (!unit) throw new HttpError(404, 'Unidad no encontrada');
    const [charges, pets] = await Promise.all([
      db.all('SELECT * FROM charges WHERE business_id = ? AND unit_id = ? ORDER BY paid_at IS NOT NULL, due_date DESC LIMIT 200', c.businessId, c.params.id),
      db.all('SELECT * FROM pets WHERE business_id = ? AND unit_id = ? ORDER BY name', c.businessId, c.params.id),
    ]);
    // Desglose de lo pendiente por concepto (modal "Desglose de cobros").
    const breakdown = Object.keys(CONCEPTS).map((k) => ({
      concept: k,
      amount: charges.filter((ch) => ch.concept === k && !ch.paid_at).reduce((s, ch) => s + ch.amount, 0),
    }));
    return json({ unit, charges, pets, breakdown });
  });

  r.post('/api/admin/units', 'tenant', async (c) => {
    const id = await insertRow(c, 'units', pick(await readJson(c.req), FIELDS)).catch(dupError);
    return json({ id }, 201);
  });

  r.put('/api/admin/units/:id', 'tenant', async (c) => {
    await updateRow(c, 'units', c.params.id, pick(await readJson(c.req), FIELDS, { partial: true })).catch(dupError);
    return json({ ok: true });
  });

  r.delete('/api/admin/units/:id', 'manager', async (c) => {
    await getRow(c, 'units', c.params.id, 'Unidad');
    await deleteRow(c, 'units', c.params.id);
    return json({ ok: true });
  });
}
