// Configuración de cartera, estado de cuenta por unidad, cuentas de cobro y liquidaciones
// (intereses de mora, cobro jurídico, retroactivo y cuota extraordinaria).
import { json, readJson, str, num, oneOf, date, HttpError } from '../lib/http.js';
import { tenantDb, uuid } from '../lib/db.js';
import { getRow } from '../lib/crud.js';
import { today, addDays } from '../lib/time.js';
import { CONCEPTS } from './charges.js';
import { brandUrl } from './files.js';
import { unitLabel } from './units.js';

export const BILLING_DEFAULTS = {
  format: 'half',          // half = media carta · letter_copy = carta original y copia · letter_series = carta, dos cuentas por hoja
  due_day: 10,             // día de vencimiento de la cuota del mes
  interest_rate: 2,        // % mensual de interés de mora
  interest_base: 'admin',  // admin = solo cuotas de administración · all = todo lo vencido (sin intereses ni jurídico)
  legal_pct: 20,           // % de honorarios de cobro jurídico sobre lo vencido
  legal_days: 90,          // días de mora para pasar a cobro jurídico
  retro_pct: 0,            // % de incremento para liquidar retroactivos
  ext_mode: 'coefficient', // reparto de cuotas extraordinarias: coefficient | equal
  ext_installments: 1,     // cuotas en que se difiere una extraordinaria
  note: '',                // texto al pie de la cuenta de cobro
  // Conceptos que usa la administración, además de la cuota de administración (que siempre está).
  concepts: ['rtc', 'ext', 'jur', 'int', 'parking', 'other'],
};
export const OPTIONAL_CONCEPTS = ['rtc', 'ext', 'jur', 'int', 'parking', 'other'];

// Lanza 400 si el concepto está desactivado en Ajustes (la cuota de administración siempre se puede usar).
export function assertConcept(billing, concept) {
  if (concept !== 'admin' && !billing.concepts.includes(concept)) {
    throw new HttpError(400, `${CONCEPTS[concept]} está desactivado en Ajustes → Cartera y cuenta de cobro`);
  }
}

export function parseBilling(raw) {
  let b = {};
  try { b = JSON.parse(raw || '{}') || {}; } catch { /* JSON dañado: valores por defecto */ }
  return { ...BILLING_DEFAULTS, ...b };
}

export async function getBilling(c) {
  const row = await tenantDb(c).first('SELECT billing FROM businesses WHERE id = ? /* business_id */', c.businessId);
  return parseBilling(row?.billing);
}

function validBilling(body) {
  const n = (v, opts, fallback) => { const x = num(v, opts); return x === null ? fallback : x; };
  return {
    format: oneOf(body.format, ['half', 'letter_copy', 'letter_series'], { label: 'Formato', fallback: BILLING_DEFAULTS.format }),
    due_day: Math.round(n(body.due_day, { min: 1, max: 28, label: 'Día de vencimiento' }, BILLING_DEFAULTS.due_day)),
    interest_rate: n(body.interest_rate, { min: 0, max: 10, label: 'Tasa de interés' }, BILLING_DEFAULTS.interest_rate),
    interest_base: oneOf(body.interest_base, ['admin', 'all'], { label: 'Base de intereses', fallback: 'admin' }),
    legal_pct: n(body.legal_pct, { min: 0, max: 50, label: 'Honorarios jurídicos' }, BILLING_DEFAULTS.legal_pct),
    legal_days: Math.round(n(body.legal_days, { min: 30, max: 720, label: 'Días para cobro jurídico' }, BILLING_DEFAULTS.legal_days)),
    retro_pct: n(body.retro_pct, { min: 0, max: 100, label: 'Incremento retroactivo' }, BILLING_DEFAULTS.retro_pct),
    ext_mode: oneOf(body.ext_mode, ['coefficient', 'equal'], { label: 'Reparto', fallback: 'coefficient' }),
    ext_installments: Math.round(n(body.ext_installments, { min: 1, max: 24, label: 'Cuotas' }, 1)),
    note: str(body.note, { max: 600, label: 'Nota' }) || '',
    concepts: Array.isArray(body.concepts)
      ? OPTIONAL_CONCEPTS.filter((k) => body.concepts.includes(k))
      : BILLING_DEFAULTS.concepts,
  };
}

const period = (v, label = 'Periodo') => {
  const p = str(v, { max: 7, label });
  if (p && !/^\d{4}-\d{2}$/.test(p)) throw new HttpError(400, `${label} inválido (AAAA-MM)`);
  return p;
};
const addMonths = (ym, n) => { const d = new Date(ym + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const sumBy = (rows) => Object.fromEntries(Object.keys(CONCEPTS).map((k) => [k, rows.filter((r) => r.concept === k).reduce((s, r) => s + r.amount, 0)]));

// Unidades del conjunto (o todas) con sus cobros pendientes agrupados por concepto.
async function pendingByUnit(c, { propertyId, unitId, onlyDebt }) {
  const db = tenantDb(c);
  const args = [c.businessId];
  let where = '';
  if (propertyId) { where += ' AND u.property_id = ?'; args.push(propertyId); }
  if (unitId) { where += ' AND u.id = ?'; args.push(unitId); }
  const [units, charges] = await Promise.all([
    db.all(
      `SELECT u.*, p.name AS property_name FROM units u JOIN properties p ON p.id = u.property_id
        WHERE u.business_id = ?${where} ORDER BY p.name, u.tower, CAST(u.number AS INTEGER), u.number`,
      ...args,
    ),
    db.all(
      `SELECT ch.* FROM charges ch JOIN units u ON u.id = ch.unit_id
        WHERE ch.business_id = ? AND ch.paid_at IS NULL${where} ORDER BY ch.due_date, ch.concept`,
      ...args,
    ),
  ]);
  const t = today();
  const byUnit = {};
  for (const ch of charges) (byUnit[ch.unit_id] ||= []).push(ch);
  return units
    .map((u) => {
      const items = byUnit[u.id] || [];
      const overdueItems = items.filter((i) => i.due_date < t);
      return {
        unit: u,
        items,
        concepts: sumBy(items),
        total: items.reduce((s, i) => s + i.amount, 0),
        overdue: overdueItems.reduce((s, i) => s + i.amount, 0),
        oldest_due: overdueItems[0]?.due_date || null,
      };
    })
    .filter((r) => !onlyDebt || r.total > 0);
}

export function routes(r) {
  // ---------- configuración (Ajustes) ----------

  // pending: saldo sin pagar por concepto (un concepto desactivado con saldo se sigue mostrando para que los totales cuadren).
  r.get('/api/admin/billing', 'tenant', async (c) => {
    const rows = await tenantDb(c).all(
      'SELECT concept, SUM(amount) AS amount FROM charges WHERE business_id = ? AND paid_at IS NULL GROUP BY concept', c.businessId,
    );
    return json({ billing: await getBilling(c), defaults: BILLING_DEFAULTS, concepts: CONCEPTS, pending: Object.fromEntries(rows.map((r) => [r.concept, r.amount])) });
  });

  r.put('/api/admin/billing', 'manager', async (c) => {
    // Lo que no venga en el cuerpo conserva lo guardado (la tasa de interés que escogió la persona, etc.).
    const billing = validBilling({ ...(await getBilling(c)), ...(await readJson(c.req)) });
    await tenantDb(c).run(`UPDATE businesses SET billing = ?, updated_at = datetime('now') WHERE id = ? /* business_id */`, JSON.stringify(billing), c.businessId);
    return json({ ok: true, billing });
  });

  // ---------- estado de cuenta por unidad (tabla de cartera) ----------

  r.get('/api/admin/charges/by-unit', 'tenant', async (c) => {
    const sp = c.url.searchParams;
    const rows = await pendingByUnit(c, { propertyId: sp.get('property'), onlyDebt: sp.get('all') !== '1' });
    return json({
      items: rows.map(({ unit: u, items, ...rest }) => ({
        unit_id: u.id, tower: u.tower, number: u.number, owner_name: u.owner_name, owner_phone: u.owner_phone, owner_email: u.owner_email,
        tenant_name: u.tenant_name, property_id: u.property_id, property_name: u.property_name, coefficient: u.coefficient,
        count: items.length, ...rest,
      })),
      concepts: CONCEPTS,
    });
  });

  // ---------- cortes mensuales ----------
  // Cada mes (corte = último día del mes): saldo anterior + cargos del mes por concepto − pagos del mes = saldo al corte.
  // Un cargo cuenta en el mes de su vencimiento; un pago, en el mes en que se pagó (o en el del vencimiento si se pagó por adelantado),
  // así la cuenta siempre cuadra. `pending` = lo que aún se debe de los cargos de ese mes.
  // ?unit=<id> una unidad · ?property=<id> un conjunto · sin filtro: toda la administración
  r.get('/api/admin/charges/cuts', 'tenant', async (c) => {
    const sp = c.url.searchParams;
    const args = [c.businessId];
    let where = '';
    if (sp.get('unit')) { where += ' AND ch.unit_id = ?'; args.push(sp.get('unit')); }
    if (sp.get('property')) { where += ' AND u.property_id = ?'; args.push(sp.get('property')); }
    const rows = await tenantDb(c).all(
      `SELECT ch.concept, ch.amount, ch.due_date, ch.paid_at FROM charges ch JOIN units u ON u.id = ch.unit_id
        WHERE ch.business_id = ?${where}`,
      ...args,
    );
    const now = today().slice(0, 7);
    if (!rows.length) return json({ months: [], concepts: CONCEPTS });
    const zero = () => Object.fromEntries(Object.keys(CONCEPTS).map((k) => [k, 0]));
    const byMonth = {};
    const month = (m) => (byMonth[m] ||= { charges: zero(), pending: zero(), paid: 0 });
    for (const ch of rows) {
      const due = ch.due_date.slice(0, 7);
      month(due).charges[ch.concept] += ch.amount;
      if (ch.paid_at) {
        const pm = ch.paid_at.slice(0, 7);
        month(pm > due ? pm : due).paid += ch.amount;
      } else month(due).pending[ch.concept] += ch.amount;
    }
    const keys = Object.keys(byMonth).sort();
    const first = keys[0];
    const last = keys.at(-1) > now ? keys.at(-1) : now;
    const out = [];
    let balance = 0;
    for (let m = first; m <= last; m = addMonths(m, 1)) {
      const x = month(m);
      const charged = Object.values(x.charges).reduce((a, b) => a + b, 0);
      const opening = balance;
      balance = opening + charged - x.paid;
      out.push({ period: m, opening, charges: x.charges, charged, paid: x.paid, closing: balance,
        pending: x.pending, pending_total: Object.values(x.pending).reduce((a, b) => a + b, 0), future: m > now });
    }
    return json({ months: out.reverse().slice(0, 36), concepts: CONCEPTS });
  });

  // Corte de un mes por unidad (?period=YYYY-MM, ?property=, ?unit=): mismas reglas que /cuts, una fila por unidad;
  // la suma de las filas da los totales del edificio.
  r.get('/api/admin/charges/cut', 'tenant', async (c) => {
    const sp = c.url.searchParams;
    const per = period(sp.get('period'), 'Mes de corte') || today().slice(0, 7);
    const args = [c.businessId];
    let where = '';
    if (sp.get('property')) { where += ' AND u.property_id = ?'; args.push(sp.get('property')); }
    if (sp.get('unit')) { where += ' AND u.id = ?'; args.push(sp.get('unit')); }
    const db = tenantDb(c);
    const [units, rows] = await Promise.all([
      db.all(
        `SELECT u.id, u.tower, u.number, u.owner_name, u.coefficient, u.property_id, p.name AS property_name
           FROM units u JOIN properties p ON p.id = u.property_id WHERE u.business_id = ?${where}
          ORDER BY p.name, u.tower, CAST(u.number AS INTEGER), u.number`,
        ...args,
      ),
      db.all(
        `SELECT ch.unit_id, ch.concept, ch.amount, ch.due_date, ch.paid_at FROM charges ch JOIN units u ON u.id = ch.unit_id
          WHERE ch.business_id = ?${where} AND substr(ch.due_date, 1, 7) <= ?`,
        ...args, per,
      ),
    ]);
    const zero = () => Object.fromEntries(Object.keys(CONCEPTS).map((k) => [k, 0]));
    const acc = Object.fromEntries(units.map((u) => [u.id, { opening: 0, charges: zero(), paid: 0, pending: 0 }]));
    for (const ch of rows) {
      const a = acc[ch.unit_id];
      const due = ch.due_date.slice(0, 7);
      const pm = ch.paid_at ? (ch.paid_at.slice(0, 7) > due ? ch.paid_at.slice(0, 7) : due) : null;
      if (due < per) a.opening += ch.amount; else a.charges[ch.concept] += ch.amount;
      if (pm && pm < per) a.opening -= ch.amount;
      if (pm === per) a.paid += ch.amount;
      if (due === per && !ch.paid_at) a.pending += ch.amount;
    }
    return json({
      period: per,
      concepts: CONCEPTS,
      items: units.map((u) => {
        const a = acc[u.id];
        const charged = Object.values(a.charges).reduce((x, y) => x + y, 0);
        return { ...u, unit_id: u.id, opening: a.opening, charges: a.charges, charged, paid: a.paid, closing: a.opening + charged - a.paid, pending_total: a.pending };
      }),
    });
  });

  // ---------- cuentas de cobro (datos para el PDF; el PDF se arma en el navegador) ----------
  // ?unit=<id> una unidad · ?property=<id> todo el conjunto · ?all=1 incluye unidades sin saldo

  r.get('/api/admin/statements', 'tenant', async (c) => {
    const sp = c.url.searchParams;
    const unitId = sp.get('unit');
    const propertyId = sp.get('property');
    if (!unitId && !propertyId) throw new HttpError(400, 'Elige una unidad o un conjunto');
    const db = tenantDb(c);
    const [biz, billing, rows, props] = await Promise.all([
      db.first('SELECT name, email, phone, logo_key FROM businesses WHERE id = ? /* business_id */', c.businessId),
      getBilling(c),
      pendingByUnit(c, { propertyId, unitId, onlyDebt: !unitId && sp.get('all') !== '1' }),
      db.all('SELECT id, name, nit, address, city, phone, email, logo_key, payment_info FROM properties WHERE business_id = ?', c.businessId),
    ]);
    if (unitId && !rows.length) throw new HttpError(404, 'Unidad no encontrada');
    const propById = Object.fromEntries(props.map(({ logo_key, ...p }) => [p.id, { ...p, logo: brandUrl(logo_key) }]));
    const t = today();
    const due = `${t.slice(0, 8)}${String(billing.due_day).padStart(2, '0')}`;
    return json({
      issued: t,
      period: t.slice(0, 7),
      pay_before: due >= t ? due : addDays(t, 5),
      business: { name: biz.name, email: biz.email, phone: biz.phone, logo: brandUrl(biz.logo_key) },
      billing,
      concepts: CONCEPTS,
      statements: rows.map(({ unit: u, ...rest }) => ({
        number: `${t.slice(0, 7).replace('-', '')}-${(u.tower ? u.tower.replace(/\D+/g, '') || u.tower.slice(-1) : '0')}${u.number}`.toUpperCase(),
        unit: {
          id: u.id, label: unitLabel(u), tower: u.tower, number: u.number, kind: u.kind, area_m2: u.area_m2, coefficient: u.coefficient,
          owner_name: u.owner_name, owner_doc: u.owner_doc, owner_email: u.owner_email, owner_phone: u.owner_phone, tenant_name: u.tenant_name,
        },
        property: propById[u.property_id],
        ...rest,
      })),
    });
  });

  // ---------- liquidaciones ----------

  // Intereses de mora del periodo (no duplica si la unidad ya tiene intereses de ese periodo).
  r.post('/api/admin/charges/interest', 'manager', async (c) => {
    const body = await readJson(c.req);
    const billing = await getBilling(c);
    assertConcept(billing, 'int');
    const property = await getRow(c, 'properties', str(body.property_id, { required: true, label: 'Conjunto' }), 'Conjunto');
    const rate = num(body.rate, { min: 0.01, max: 10, label: 'Tasa' }) ?? billing.interest_rate;
    if (!rate) throw new HttpError(400, 'Configura la tasa de interés en Ajustes');
    const base = oneOf(body.base, ['admin', 'all'], { label: 'Base', fallback: billing.interest_base });
    const per = period(body.period) || today().slice(0, 7);
    const t = today();
    const db = tenantDb(c);
    const rows = await db.all(
      `SELECT ch.unit_id, SUM(ch.amount) AS overdue FROM charges ch JOIN units u ON u.id = ch.unit_id
        WHERE ch.business_id = ? AND u.property_id = ? AND ch.paid_at IS NULL AND ch.due_date < ?
          AND ${base === 'admin' ? "ch.concept = 'admin'" : "ch.concept NOT IN ('int','jur')"}
          AND NOT EXISTS (SELECT 1 FROM charges x WHERE x.business_id = ch.business_id AND x.unit_id = ch.unit_id AND x.concept = 'int' AND x.period = ?)
        GROUP BY ch.unit_id`,
      c.businessId, property.id, t, per,
    );
    const stmts = rows.map((x) => ({ ...x, v: Math.round((x.overdue * rate) / 100) })).filter((x) => x.v > 0).map((x) => db.prepare(
      `INSERT INTO charges (id, business_id, unit_id, concept, period, description, amount, due_date) VALUES (?, ?, ?, 'int', ?, ?, ?, ?)`,
      uuid(), c.businessId, x.unit_id, per, `Intereses de mora ${rate}% ${per}`, x.v, t,
    ));
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true, created: stmts.length, rate });
  });

  // Cobro jurídico: honorarios (% de lo vencido) a las unidades con más de N días de mora.
  r.post('/api/admin/charges/legal', 'manager', async (c) => {
    const body = await readJson(c.req);
    const billing = await getBilling(c);
    assertConcept(billing, 'jur');
    const property = await getRow(c, 'properties', str(body.property_id, { required: true, label: 'Conjunto' }), 'Conjunto');
    const pct = num(body.pct, { min: 0.1, max: 50, label: 'Porcentaje' }) ?? billing.legal_pct;
    const days = Math.round(num(body.days, { min: 1, max: 720, label: 'Días' }) ?? billing.legal_days);
    if (!pct) throw new HttpError(400, 'Configura el porcentaje de cobro jurídico en Ajustes');
    const t = today();
    const limit = addDays(t, -days);
    const per = t.slice(0, 7);
    const db = tenantDb(c);
    const rows = await db.all(
      `SELECT ch.unit_id, SUM(ch.amount) AS overdue, MIN(ch.due_date) AS oldest FROM charges ch JOIN units u ON u.id = ch.unit_id
        WHERE ch.business_id = ? AND u.property_id = ? AND ch.paid_at IS NULL AND ch.due_date < ? AND ch.concept <> 'jur'
          AND NOT EXISTS (SELECT 1 FROM charges x WHERE x.business_id = ch.business_id AND x.unit_id = ch.unit_id AND x.concept = 'jur' AND x.period = ?)
        GROUP BY ch.unit_id HAVING MIN(ch.due_date) <= ?`,
      c.businessId, property.id, t, per, limit,
    );
    const stmts = rows.map((x) => ({ ...x, v: Math.round((x.overdue * pct) / 100) })).filter((x) => x.v > 0).map((x) => db.prepare(
      `INSERT INTO charges (id, business_id, unit_id, concept, period, description, amount, due_date) VALUES (?, ?, ?, 'jur', ?, ?, ?, ?)`,
      uuid(), c.businessId, x.unit_id, per, `Honorarios cobro jurídico ${pct}% (mora > ${days} días)`, x.v, t,
    ));
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true, created: stmts.length, pct, days });
  });

  // Retroactivo: % de incremento sobre las cuotas de administración de un rango de periodos.
  r.post('/api/admin/charges/retro', 'manager', async (c) => {
    const body = await readJson(c.req);
    const billing = await getBilling(c);
    assertConcept(billing, 'rtc');
    const property = await getRow(c, 'properties', str(body.property_id, { required: true, label: 'Conjunto' }), 'Conjunto');
    const from = period(body.from, 'Desde');
    const to = period(body.to, 'Hasta');
    if (!from || !to || from > to) throw new HttpError(400, 'Rango de periodos inválido');
    const pct = num(body.pct, { min: 0.01, max: 100, label: 'Incremento' }) ?? billing.retro_pct;
    if (!pct) throw new HttpError(400, 'Indica el % de incremento (o configúralo en Ajustes)');
    const due = date(body.due_date, { label: 'Vencimiento' }) || addDays(today(), 15);
    const db = tenantDb(c);
    const rows = await db.all(
      `SELECT ch.unit_id, SUM(ch.amount) AS base, COUNT(*) AS n FROM charges ch JOIN units u ON u.id = ch.unit_id
        WHERE ch.business_id = ? AND u.property_id = ? AND ch.concept = 'admin' AND ch.period BETWEEN ? AND ?
        GROUP BY ch.unit_id`,
      c.businessId, property.id, from, to,
    );
    const stmts = rows.map((x) => ({ ...x, v: Math.round((x.base * pct) / 100) })).filter((x) => x.v > 0).map((x) => db.prepare(
      `INSERT INTO charges (id, business_id, unit_id, concept, period, description, amount, due_date) VALUES (?, ?, ?, 'rtc', ?, ?, ?, ?)`,
      uuid(), c.businessId, x.unit_id, to, `Retroactivo ${pct}% ${from} a ${to} (${x.n} cuotas)`, x.v, due,
    ));
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true, created: stmts.length, pct });
  });

  // Cuota extraordinaria: total aprobado por asamblea repartido por coeficiente o en partes iguales, en N cuotas mensuales.
  r.post('/api/admin/charges/extra', 'manager', async (c) => {
    const body = await readJson(c.req);
    const billing = await getBilling(c);
    assertConcept(billing, 'ext');
    const property = await getRow(c, 'properties', str(body.property_id, { required: true, label: 'Conjunto' }), 'Conjunto');
    const total = num(body.total, { min: 1, max: 1e12, label: 'Valor total' });
    if (!total) throw new HttpError(400, 'Valor total es obligatorio');
    const description = str(body.description, { required: true, max: 160, label: 'Descripción' });
    const mode = oneOf(body.mode, ['coefficient', 'equal'], { label: 'Reparto', fallback: billing.ext_mode });
    const n = Math.round(num(body.installments, { min: 1, max: 24, label: 'Cuotas' }) ?? billing.ext_installments);
    const first = date(body.due_date, { required: true, label: 'Primer vencimiento' });
    const db = tenantDb(c);
    const units = await db.all('SELECT id, coefficient FROM units WHERE business_id = ? AND property_id = ?', c.businessId, property.id);
    if (!units.length) throw new HttpError(400, 'El conjunto no tiene unidades');
    const coefSum = units.reduce((s, u) => s + (u.coefficient || 0), 0);
    if (mode === 'coefficient' && !coefSum) throw new HttpError(400, 'Las unidades no tienen coeficiente: usa reparto en partes iguales');
    const stmts = [];
    for (const u of units) {
      const share = mode === 'equal' ? total / units.length : (total * (u.coefficient || 0)) / coefSum;
      const each = Math.round(share / n);
      if (each <= 0) continue;
      for (let k = 0; k < n; k++) {
        const dueK = `${addMonths(first.slice(0, 7), k)}-${first.slice(8)}`;
        stmts.push(db.prepare(
          `INSERT INTO charges (id, business_id, unit_id, concept, period, description, amount, due_date) VALUES (?, ?, ?, 'ext', ?, ?, ?, ?)`,
          uuid(), c.businessId, u.id, dueK.slice(0, 7), n > 1 ? `${description} (cuota ${k + 1} de ${n})` : description, each, dueK,
        ));
      }
    }
    for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
    return json({ ok: true, units: units.length, created: stmts.length });
  });
}
