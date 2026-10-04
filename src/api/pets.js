// Censo de mascotas por unidad (control de vacunación y razas potencialmente peligrosas).
import { json, readJson, str, oneOf, date } from '../lib/http.js';
import { tenantDb } from '../lib/db.js';
import { pick, insertRow, updateRow, deleteRow, propertyFilter, searchFilter } from '../lib/crud.js';

const FIELDS = {
  unit_id: (v) => str(v, { required: true, max: 40, label: 'Unidad' }),
  name: (v) => str(v, { required: true, max: 80, label: 'Nombre' }),
  species: (v) => oneOf(v, ['perro', 'gato', 'ave', 'otro'], { label: 'Especie', fallback: 'perro' }),
  breed: (v) => str(v, { max: 80, label: 'Raza' }),
  potentially_dangerous: (v) => (v === true || v === 1 || v === '1' ? 1 : 0),
  vaccinated_until: (v) => date(v, { label: 'Vacunas al día hasta' }),
  notes: (v) => str(v, { max: 1000, label: 'Notas' }),
};

export function routes(r) {
  r.get('/api/admin/pets', 'tenant', async (c) => {
    const [pf, pa] = propertyFilter(c, 'u.property_id');
    const [qf, qa] = searchFilter(c, ['pt.name', 'pt.breed', 'u.number', 'u.owner_name']);
    const items = await tenantDb(c).all(
      `SELECT pt.*, u.tower, u.number, u.owner_name, u.owner_phone, u.property_id, p.name AS property_name,
              (SELECT f.id FROM files f WHERE f.business_id = pt.business_id AND f.ref_type = 'pet' AND f.ref_id = pt.id
                 AND f.content_type LIKE 'image/%' ORDER BY f.created_at DESC LIMIT 1) AS photo_id
         FROM pets pt JOIN units u ON u.id = pt.unit_id JOIN properties p ON p.id = u.property_id
        WHERE pt.business_id = ?${pf}${qf}
        ORDER BY p.name, u.tower, u.number, pt.name`,
      c.businessId, ...pa, ...qa,
    );
    return json({ items });
  });

  r.post('/api/admin/pets', 'tenant', async (c) => {
    const id = await insertRow(c, 'pets', pick(await readJson(c.req), FIELDS));
    return json({ id }, 201);
  });

  r.put('/api/admin/pets/:id', 'tenant', async (c) => {
    await updateRow(c, 'pets', c.params.id, pick(await readJson(c.req), FIELDS, { partial: true }), { touch: false });
    return json({ ok: true });
  });

  r.delete('/api/admin/pets/:id', 'tenant', async (c) => {
    await deleteRow(c, 'pets', c.params.id);
    return json({ ok: true });
  });
}
