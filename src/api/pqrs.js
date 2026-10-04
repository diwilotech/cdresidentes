// PQRS de convivencia: peticiones, quejas, reclamos y sugerencias de los residentes.
import { json, readJson, str, oneOf } from '../lib/http.js';
import { tenantDb } from '../lib/db.js';
import { pick, insertRow, updateRow, deleteRow, getRow, propertyFilter, searchFilter } from '../lib/crud.js';

export const PQRS_CATEGORIES = ['ruido', 'mascotas', 'parqueadero', 'seguridad', 'mantenimiento', 'aseo', 'convivencia', 'otro'];

const FIELDS = {
  property_id: (v) => str(v, { required: true, max: 40, label: 'Conjunto' }),
  unit_id: (v) => str(v, { max: 40, label: 'Unidad' }),
  kind: (v) => oneOf(v, ['peticion', 'queja', 'reclamo', 'sugerencia'], { label: 'Tipo', fallback: 'queja' }),
  category: (v) => oneOf(v, PQRS_CATEGORIES, { label: 'Categoría', fallback: 'otro' }),
  subject: (v) => str(v, { required: true, max: 160, label: 'Asunto' }),
  detail: (v) => str(v, { max: 4000, label: 'Detalle' }),
  reporter: (v) => str(v, { max: 120, label: 'Quién reporta' }),
  priority: (v) => oneOf(v, ['baja', 'normal', 'alta'], { label: 'Prioridad', fallback: 'normal' }),
  status: (v) => oneOf(v, ['open', 'in_progress', 'closed'], { label: 'Estado', fallback: 'open' }),
  response: (v) => str(v, { max: 4000, label: 'Respuesta' }),
};

export function routes(r) {
  r.get('/api/admin/pqrs', 'tenant', async (c) => {
    const sp = c.url.searchParams;
    const [pf, pa] = propertyFilter(c, 'q.property_id');
    const [qf, qa] = searchFilter(c, ['q.subject', 'q.detail', 'q.reporter', 'u.number']);
    let extra = '';
    const ea = [];
    if (sp.get('status')) { extra += ' AND q.status = ?'; ea.push(sp.get('status')); }
    if (sp.get('category')) { extra += ' AND q.category = ?'; ea.push(sp.get('category')); }
    const db = tenantDb(c);
    const [items, stats] = await Promise.all([
      db.all(
        `SELECT q.*, u.tower, u.number, p.name AS property_name
           FROM pqrs q JOIN properties p ON p.id = q.property_id LEFT JOIN units u ON u.id = q.unit_id
          WHERE q.business_id = ?${pf}${qf}${extra}
          ORDER BY q.status = 'closed', CASE q.priority WHEN 'alta' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, q.created_at DESC
          LIMIT 300`,
        c.businessId, ...pa, ...qa, ...ea,
      ),
      // Tiempo promedio de respuesta (horas) y conteo por categoría de las abiertas.
      db.first(
        `SELECT COUNT(CASE WHEN status <> 'closed' THEN 1 END) AS open,
                ROUND(AVG(CASE WHEN closed_at IS NOT NULL THEN (julianday(closed_at) - julianday(created_at)) * 24 END), 1) AS avg_hours
           FROM pqrs q WHERE q.business_id = ?${pf}`,
        c.businessId, ...pa,
      ),
    ]);
    return json({ items, stats });
  });

  r.post('/api/admin/pqrs', 'tenant', async (c) => {
    const id = await insertRow(c, 'pqrs', pick(await readJson(c.req), FIELDS));
    return json({ id }, 201);
  });

  r.put('/api/admin/pqrs/:id', 'tenant', async (c) => {
    const data = pick(await readJson(c.req), FIELDS, { partial: true });
    if (data.status) {
      const prev = await getRow(c, 'pqrs', c.params.id, 'PQRS');
      if (data.status === 'closed' && prev.status !== 'closed') data.closed_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
      if (data.status !== 'closed') data.closed_at = null;
    }
    await updateRow(c, 'pqrs', c.params.id, data);
    return json({ ok: true });
  });

  r.delete('/api/admin/pqrs/:id', 'manager', async (c) => {
    await deleteRow(c, 'pqrs', c.params.id);
    return json({ ok: true });
  });
}
