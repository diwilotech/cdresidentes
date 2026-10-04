// Zonas comunes (salón social, BBQ, parqueadero de visitantes…) y sus reservas.
import { json, readJson, str, num, oneOf, date, HttpError } from '../lib/http.js';
import { tenantDb } from '../lib/db.js';
import { pick, insertRow, updateRow, deleteRow, getRow, propertyFilter } from '../lib/crud.js';

const time = (label) => (v) => {
  const s = str(v, { required: true, max: 5, label });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpError(400, `${label} no es válida`);
  return s;
};

const AMENITY = {
  property_id: (v) => str(v, { required: true, max: 40, label: 'Conjunto' }),
  name: (v) => str(v, { required: true, max: 120, label: 'Nombre' }),
  fee: (v) => Math.round(num(v, { min: 0, max: 1e9, label: 'Tarifa' }) || 0),
  fee_unit: (v) => oneOf(v, ['evento', 'hora', 'dia'], { label: 'Unidad de cobro', fallback: 'evento' }),
  capacity: (v) => num(v, { min: 0, max: 100000, label: 'Capacidad' }),
  rules: (v) => str(v, { max: 2000, label: 'Reglamento' }),
  active: (v) => (v === false || v === 0 || v === '0' ? 0 : 1),
};

const BOOKING = {
  amenity_id: (v) => str(v, { required: true, max: 40, label: 'Zona' }),
  unit_id: (v) => str(v, { max: 40, label: 'Unidad' }),
  date: (v) => date(v, { required: true, label: 'Fecha' }),
  start_time: time('Hora de inicio'),
  end_time: time('Hora de fin'),
  holder: (v) => str(v, { max: 120, label: 'Responsable' }),
  amount: (v) => num(v, { min: 0, max: 1e9, label: 'Valor' }),
  paid: (v) => (v === true || v === 1 || v === '1' ? 1 : 0),
  status: (v) => oneOf(v, ['pending', 'approved', 'rejected', 'cancelled'], { label: 'Estado', fallback: 'pending' }),
  notes: (v) => str(v, { max: 1000, label: 'Notas' }),
};

// Valor de la reserva según la tarifa de la zona.
function priceFor(amenity, start, end) {
  if (amenity.fee_unit === 'hora') {
    const mins = (h) => +h.slice(0, 2) * 60 + +h.slice(3);
    return Math.round((amenity.fee * Math.max(0, mins(end) - mins(start))) / 60);
  }
  return amenity.fee;
}

async function assertFree(c, data, exceptId = '') {
  if (data.end_time <= data.start_time) throw new HttpError(400, 'La hora de fin debe ser después del inicio');
  const clash = await tenantDb(c).first(
    `SELECT 1 FROM bookings WHERE business_id = ? AND amenity_id = ? AND date = ? AND id <> ?
        AND status IN ('pending','approved') AND start_time < ? AND end_time > ?`,
    c.businessId, data.amenity_id, data.date, exceptId, data.end_time, data.start_time,
  );
  if (clash) throw new HttpError(409, 'La zona ya está reservada en ese horario');
}

export function routes(r) {
  r.get('/api/admin/amenities', 'tenant', async (c) => {
    const [pf, pa] = propertyFilter(c, 'a.property_id');
    const items = await tenantDb(c).all(
      `SELECT a.*, p.name AS property_name FROM amenities a JOIN properties p ON p.id = a.property_id
        WHERE a.business_id = ?${pf} ORDER BY p.name, a.name`,
      c.businessId, ...pa,
    );
    return json({ items });
  });

  r.post('/api/admin/amenities', 'manager', async (c) => {
    const id = await insertRow(c, 'amenities', pick(await readJson(c.req), AMENITY));
    return json({ id }, 201);
  });

  r.put('/api/admin/amenities/:id', 'manager', async (c) => {
    await updateRow(c, 'amenities', c.params.id, pick(await readJson(c.req), AMENITY, { partial: true }), { touch: false });
    return json({ ok: true });
  });

  r.delete('/api/admin/amenities/:id', 'manager', async (c) => {
    await deleteRow(c, 'amenities', c.params.id);
    return json({ ok: true });
  });

  // Reservas de un mes (?month=YYYY-MM).
  r.get('/api/admin/bookings', 'tenant', async (c) => {
    const month = c.url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Mes inválido');
    const [pf, pa] = propertyFilter(c, 'a.property_id');
    const items = await tenantDb(c).all(
      `SELECT b.*, a.name AS amenity_name, a.property_id, u.tower, u.number, u.owner_name
         FROM bookings b JOIN amenities a ON a.id = b.amenity_id LEFT JOIN units u ON u.id = b.unit_id
        WHERE b.business_id = ? AND substr(b.date, 1, 7) = ?${pf}
        ORDER BY b.date, b.start_time`,
      c.businessId, month, ...pa,
    );
    return json({ items, month });
  });

  r.post('/api/admin/bookings', 'tenant', async (c) => {
    const data = pick(await readJson(c.req), BOOKING);
    const amenity = await getRow(c, 'amenities', data.amenity_id, 'Zona');
    if (!amenity.active) throw new HttpError(400, 'La zona no está disponible para reservas');
    await assertFree(c, data);
    if (data.amount === null) data.amount = priceFor(amenity, data.start_time, data.end_time);
    const id = await insertRow(c, 'bookings', data);
    return json({ id }, 201);
  });

  r.put('/api/admin/bookings/:id', 'tenant', async (c) => {
    const prev = await getRow(c, 'bookings', c.params.id, 'Reserva');
    const data = pick(await readJson(c.req), BOOKING, { partial: true });
    const merged = { ...prev, ...data };
    if ((data.date || data.start_time || data.end_time || data.amenity_id) && ['pending', 'approved'].includes(merged.status)) {
      await assertFree(c, merged, c.params.id);
    }
    await updateRow(c, 'bookings', c.params.id, data, { touch: false });
    return json({ ok: true });
  });

  r.delete('/api/admin/bookings/:id', 'tenant', async (c) => {
    await deleteRow(c, 'bookings', c.params.id);
    return json({ ok: true });
  });
}
