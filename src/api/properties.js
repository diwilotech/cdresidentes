// Conjuntos / edificios (las "sedes" que maneja la administración).
import { json, readJson, str, num, email, oneOf } from '../lib/http.js';
import { tenantDb, uuid } from '../lib/db.js';
import { pick, insertRow, updateRow, deleteRow, getRow } from '../lib/crud.js';
import { brandUrl, readImage } from './files.js';

const FIELDS = {
  name: (v) => str(v, { required: true, max: 120, label: 'Nombre del conjunto' }),
  nit: (v) => str(v, { max: 30, label: 'NIT' }),
  address: (v) => str(v, { max: 200, label: 'Dirección' }),
  city: (v) => str(v, { max: 80, label: 'Ciudad' }),
  phone: (v) => str(v, { max: 60, label: 'Teléfonos' }),
  email: (v) => email(v, { label: 'Correo' }),
  towers: (v) => str(v, { max: 300, label: 'Torres' }),
  admin_fee: (v) => num(v, { min: 0, max: 1e7, label: 'Cuota por m²' }),
  payment_info: (v) => str(v, { max: 600, label: 'Datos de pago' }),
  notes: (v) => str(v, { max: 2000, label: 'Notas' }),
  status: (v) => oneOf(v, ['active', 'archived'], { label: 'Estado', fallback: 'active' }),
};

export function routes(r) {
  r.get('/api/admin/properties', 'tenant', async (c) => {
    const rows = await tenantDb(c).all(
      `SELECT p.*,
              (SELECT COUNT(*) FROM units u WHERE u.business_id = p.business_id AND u.property_id = p.id) AS units,
              (SELECT COALESCE(SUM(u.residents), 0) FROM units u WHERE u.business_id = p.business_id AND u.property_id = p.id) AS residents,
              (SELECT COALESCE(SUM(ch.amount), 0) FROM charges ch JOIN units u ON u.id = ch.unit_id
                WHERE ch.business_id = p.business_id AND u.property_id = p.id AND ch.paid_at IS NULL AND ch.due_date < date('now', '-5 hours')) AS overdue,
              (SELECT COUNT(*) FROM pqrs q WHERE q.business_id = p.business_id AND q.property_id = p.id AND q.status <> 'closed') AS open_pqrs
         FROM properties p
        WHERE p.business_id = ? ORDER BY p.status, p.name`,
      c.businessId,
    );
    return json({ items: rows.map(({ logo_key, ...p }) => ({ ...p, logo: brandUrl(logo_key) })) });
  });

  r.get('/api/admin/properties/:id', 'tenant', async (c) => {
    const { logo_key, ...p } = await getRow(c, 'properties', c.params.id, 'Conjunto');
    return json({ ...p, logo: brandUrl(logo_key) });
  });

  r.post('/api/admin/properties', 'manager', async (c) => {
    const id = await insertRow(c, 'properties', pick(await readJson(c.req), FIELDS));
    return json({ id }, 201);
  });

  r.put('/api/admin/properties/:id', 'manager', async (c) => {
    await updateRow(c, 'properties', c.params.id, pick(await readJson(c.req), FIELDS, { partial: true }));
    return json({ ok: true });
  });

  r.delete('/api/admin/properties/:id', 'manager', async (c) => {
    await deleteRow(c, 'properties', c.params.id);
    return json({ ok: true });
  });

  r.post('/api/admin/properties/:id/logo', 'manager', async (c) => {
    const prev = await getRow(c, 'properties', c.params.id, 'Conjunto');
    const file = await readImage(c);
    const key = `${c.businessId}/brand/${uuid()}`;
    await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    await updateRow(c, 'properties', c.params.id, { logo_key: key });
    if (prev.logo_key) c.ctx.waitUntil(c.env.FILES.delete(prev.logo_key));
    return json({ ok: true, logo: brandUrl(key) }, 201);
  });
}
