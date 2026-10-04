// Solicitudes operativas y de portería: mudanzas, visitas, mantenimiento, domicilios y alarmas.
import { json, readJson, str, oneOf, date } from '../lib/http.js';
import { tenantDb } from '../lib/db.js';
import { pick, insertRow, updateRow, deleteRow, propertyFilter, searchFilter } from '../lib/crud.js';

export const REQUEST_KINDS = ['mudanza', 'visita', 'mantenimiento', 'domicilio', 'alarma', 'otro'];
const STATUSES = ['pending', 'approved', 'rejected', 'done'];

const FIELDS = {
  property_id: (v) => str(v, { required: true, max: 40, label: 'Conjunto' }),
  unit_id: (v) => str(v, { max: 40, label: 'Unidad' }),
  kind: (v) => oneOf(v, REQUEST_KINDS, { label: 'Tipo', fallback: 'otro' }),
  title: (v) => str(v, { required: true, max: 160, label: 'Asunto' }),
  detail: (v) => str(v, { max: 3000, label: 'Detalle' }),
  scheduled_at: (v) => date(v, { withTime: true, label: 'Fecha y hora' }),
  status: (v) => oneOf(v, STATUSES, { label: 'Estado', fallback: 'pending' }),
  resolution: (v) => str(v, { max: 2000, label: 'Respuesta' }),
};

export function routes(r) {
  r.get('/api/admin/requests', 'tenant', async (c) => {
    const sp = c.url.searchParams;
    const [pf, pa] = propertyFilter(c, 'rq.property_id');
    const [qf, qa] = searchFilter(c, ['rq.title', 'rq.detail', 'u.number', 'u.owner_name']);
    let extra = '';
    const ea = [];
    if (sp.get('status')) { extra += ' AND rq.status = ?'; ea.push(sp.get('status')); }
    if (sp.get('kind')) { extra += ' AND rq.kind = ?'; ea.push(sp.get('kind')); }
    const items = await tenantDb(c).all(
      `SELECT rq.*, u.tower, u.number, u.owner_name, p.name AS property_name
         FROM requests rq JOIN properties p ON p.id = rq.property_id LEFT JOIN units u ON u.id = rq.unit_id
        WHERE rq.business_id = ?${pf}${qf}${extra}
        ORDER BY CASE rq.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, COALESCE(rq.scheduled_at, rq.created_at) DESC
        LIMIT 300`,
      c.businessId, ...pa, ...qa, ...ea,
    );
    return json({ items });
  });

  r.post('/api/admin/requests', 'tenant', async (c) => {
    const data = pick(await readJson(c.req), FIELDS);
    const id = await insertRow(c, 'requests', { ...data, created_by: c.user.id });
    return json({ id }, 201);
  });

  r.put('/api/admin/requests/:id', 'tenant', async (c) => {
    await updateRow(c, 'requests', c.params.id, pick(await readJson(c.req), FIELDS, { partial: true }));
    return json({ ok: true });
  });

  r.delete('/api/admin/requests/:id', 'manager', async (c) => {
    await deleteRow(c, 'requests', c.params.id);
    return json({ ok: true });
  });
}
