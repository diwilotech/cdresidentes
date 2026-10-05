// Cartera: obligaciones de cada unidad, pagos, antigüedad y cuotas mensuales.
import { json, readJson, str, num, oneOf, date, HttpError } from '../lib/http.js';
import { tenantDb, uuid } from '../lib/db.js';
import { pick, insertRow, updateRow, deleteRow, getRow } from '../lib/crud.js';
import { today } from '../lib/time.js';
import { getBilling, assertConcept } from './billing.js';

export const CONCEPTS = {
  admin: 'Cuota de administración',
  rtc: 'Retroactivo',
  parking: 'Parqueadero',
  ext: 'Cuota extraordinaria',
  jur: 'Cobranza jurídica',
  int: 'Intereses de mora',
  other: 'Otro',
};

const FIELDS = {
  unit_id: (v) => str(v, { required: true, max: 40, label: 'Unidad' }),
  concept: (v) => oneOf(v, Object.keys(CONCEPTS), { label: 'Concepto', fallback: 'admin' }),
  period: (v) => {
    const p = str(v, { max: 7, label: 'Periodo' });
    if (p && !/^\d{4}-\d{2}$/.test(p)) throw new HttpError(400, 'Periodo inválido (AAAA-MM)');
    return p;
  },
  description: (v) => str(v, { max: 200, label: 'Descripción' }),
  amount: (v) => {
    const n = num(v, { min: 1, max: 1e11, label: 'Valor' });
    if (n === null) throw new HttpError(400, 'Valor es obligatorio');
    return Math.round(n);
  },
  due_date: (v) => date(v, { required: true, label: 'Fecha de vencimiento' }),
};

function filters(c) {
  const sp = c.url.searchParams;
  let sql = '';
  const args = [];
  const t = today();
  if (sp.get('property')) { sql += ' AND u.property_id = ?'; args.push(sp.get('property')); }
  if (sp.get('unit')) { sql += ' AND ch.unit_id = ?'; args.push(sp.get('unit')); }
  if (sp.get('concept')) { sql += ' AND ch.concept = ?'; args.push(sp.get('concept')); }
  const st = sp.get('status');
  if (st === 'pending') sql += ' AND ch.paid_at IS NULL';
  if (st === 'paid') sql += ' AND ch.paid_at IS NOT NULL';
  if (st === 'overdue') { sql += ' AND ch.paid_at IS NULL AND ch.due_date < ?'; args.push(t); }
  return [sql, args];
}

export function routes(r) {
  r.get('/api/admin/charges', 'tenant', async (c) => {
    const [f, a] = filters(c);
    const items = await tenantDb(c).all(
      `SELECT ch.*, u.tower, u.number, u.owner_name, u.property_id, p.name AS property_name
         FROM charges ch JOIN units u ON u.id = ch.unit_id JOIN properties p ON p.id = u.property_id
        WHERE ch.business_id = ?${f}
        ORDER BY ch.paid_at IS NOT NULL, ch.due_date DESC LIMIT 3000`,
      c.businessId, ...a,
    );
    return json({ items, concepts: CONCEPTS });
  });

  // Totales, antigüedad de la cartera y recaudo de los últimos 12 meses.
  r.get('/api/admin/charges/summary', 'tenant', async (c) => {
    const p = c.url.searchParams.get('property');
    const pf = p ? ' AND u.property_id = ?' : '';
    const pa = p ? [p] : [];
    const t = today();
    const db = tenantDb(c);
    const base = `FROM charges ch JOIN units u ON u.id = ch.unit_id WHERE ch.business_id = ?${pf}`;
    const [totals, aging, byConcept, monthly, debtors] = await Promise.all([
      db.first(
        `SELECT COALESCE(SUM(CASE WHEN ch.paid_at IS NULL THEN ch.amount END), 0) AS pending,
                COALESCE(SUM(CASE WHEN ch.paid_at IS NULL AND ch.due_date < ? THEN ch.amount END), 0) AS overdue,
                COALESCE(SUM(CASE WHEN ch.paid_at >= ? THEN ch.amount END), 0) AS collected_month,
                COALESCE(SUM(CASE WHEN substr(ch.due_date, 1, 7) = ? THEN ch.amount END), 0) AS billed_month
           ${base}`,
        t, t.slice(0, 8) + '01', t.slice(0, 7), c.businessId, ...pa,
      ),
      db.all(
        `SELECT CASE WHEN julianday(?) - julianday(ch.due_date) <= 30 THEN '0-30'
                     WHEN julianday(?) - julianday(ch.due_date) <= 60 THEN '31-60'
                     WHEN julianday(?) - julianday(ch.due_date) <= 90 THEN '61-90'
                     ELSE '90+' END AS bucket, SUM(ch.amount) AS amount, COUNT(DISTINCT ch.unit_id) AS units
           ${base} AND ch.paid_at IS NULL AND ch.due_date < ? GROUP BY bucket`,
        t, t, t, c.businessId, ...pa, t,
      ),
      db.all(`SELECT ch.concept, SUM(ch.amount) AS amount ${base} AND ch.paid_at IS NULL GROUP BY ch.concept`, c.businessId, ...pa),
      db.all(
        `SELECT substr(ch.paid_at, 1, 7) AS month, SUM(ch.amount) AS collected
           ${base} AND ch.paid_at >= date(?, 'start of month', '-11 months') GROUP BY month ORDER BY month`,
        c.businessId, ...pa, t,
      ),
      db.first(
        `SELECT COUNT(DISTINCT ch.unit_id) AS debtors, (SELECT COUNT(*) FROM units u WHERE u.business_id = ?${pf}) AS units
           ${base} AND ch.paid_at IS NULL AND ch.due_date < ?`,
        c.businessId, ...pa, c.businessId, ...pa, t,
      ),
    ]);
    return json({ ...totals, ...debtors, aging, byConcept, monthly, concepts: CONCEPTS });
  });

  r.post('/api/admin/charges', 'tenant', async (c) => {
    const data = pick(await readJson(c.req), FIELDS);
    assertConcept(await getBilling(c), data.concept);
    const id = await insertRow(c, 'charges', data);
    return json({ id }, 201);
  });

  // Cuota de administración del mes para todas las unidades de un conjunto.
  //   mode 'coefficient': amount = presupuesto mensual total, se reparte por coeficiente
  //   mode 'area':        amount = valor por m²
  //   mode 'fixed':       amount = valor igual para cada unidad
  r.post('/api/admin/charges/generate', 'manager', async (c) => {
    const body = await readJson(c.req);
    const property = await getRow(c, 'properties', str(body.property_id, { required: true, label: 'Conjunto' }), 'Conjunto');
    const period = FIELDS.period(body.period);
    if (!period) throw new HttpError(400, 'Periodo es obligatorio');
    const due = date(body.due_date, { required: true, label: 'Vencimiento' });
    const mode = oneOf(body.mode, ['coefficient', 'area', 'fixed'], { label: 'Modo', fallback: 'coefficient' });
    const amount = num(body.amount, { min: 1, max: 1e11, label: 'Valor' });
    if (!amount) throw new HttpError(400, 'Valor es obligatorio');
    const db = tenantDb(c);
    const units = await db.all('SELECT id, area_m2, coefficient FROM units WHERE business_id = ? AND property_id = ?', c.businessId, property.id);
    if (!units.length) throw new HttpError(400, 'El conjunto no tiene unidades');
    const value = (u) =>
      mode === 'fixed' ? amount : mode === 'area' ? amount * (u.area_m2 || 0) : (amount * (u.coefficient || 0)) / 100;
    const stmts = units
      .map((u) => ({ u, v: Math.round(value(u)) }))
      .filter(({ v }) => v > 0)
      .map(({ u, v }) => db.prepare(
        `INSERT OR IGNORE INTO charges (id, business_id, unit_id, concept, period, description, amount, due_date)
         VALUES (?, ?, ?, 'admin', ?, ?, ?, ?)`,
        uuid(), c.businessId, u.id, period, `${CONCEPTS.admin} ${period}`, v, due,
      ));
    if (!stmts.length) throw new HttpError(400, mode === 'coefficient' ? 'Las unidades no tienen coeficiente' : 'Las unidades no tienen área');
    const res = await db.batch(stmts);
    const created = res.reduce((s, x) => s + (x.meta?.changes || 0), 0);
    return json({ ok: true, created, skipped: units.length - created });
  });

  // Intereses, cobro jurídico, retroactivo y cuota extraordinaria: api/billing.js

  r.post('/api/admin/charges/:id/pay', 'tenant', async (c) => {
    const body = await readJson(c.req);
    await updateRow(c, 'charges', c.params.id, {
      paid_at: date(body.paid_at, { label: 'Fecha de pago' }) || today(),
      payment_ref: str(body.payment_ref, { max: 120, label: 'Referencia' }),
    }, { touch: false });
    return json({ ok: true });
  });

  // Pagar todo lo pendiente de una unidad.
  r.post('/api/admin/units/:id/pay-all', 'tenant', async (c) => {
    const body = await readJson(c.req);
    await getRow(c, 'units', c.params.id, 'Unidad');
    const res = await tenantDb(c).run(
      'UPDATE charges SET paid_at = ?, payment_ref = ? WHERE business_id = ? AND unit_id = ? AND paid_at IS NULL',
      date(body.paid_at, { label: 'Fecha de pago' }) || today(), str(body.payment_ref, { max: 120, label: 'Referencia' }),
      c.businessId, c.params.id,
    );
    return json({ ok: true, paid: res.meta.changes });
  });

  r.post('/api/admin/charges/:id/unpay', 'manager', async (c) => {
    await updateRow(c, 'charges', c.params.id, { paid_at: null, payment_ref: null }, { touch: false });
    return json({ ok: true });
  });

  r.delete('/api/admin/charges/:id', 'manager', async (c) => {
    await deleteRow(c, 'charges', c.params.id);
    return json({ ok: true });
  });
}
