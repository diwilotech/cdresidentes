// Inicio: indicadores de la administración (o de un conjunto con ?property=).
import { json, HttpError } from '../lib/http.js';
import { tenantDb } from '../lib/db.js';
import { today } from '../lib/time.js';
import { UNIT_DEBT_SQL } from './units.js';
import { businessBySlug, isValidSlug } from '../lib/tenant.js';
import { brandUrl } from './files.js';

export function routes(r) {
  r.get('/api/admin/dashboard', 'tenant', async (c) => {
    const p = c.url.searchParams.get('property');
    const db = tenantDb(c);
    const t = today();
    const up = p ? ' AND u.property_id = ?' : '';
    const pp = p ? ' AND property_id = ?' : '';
    const pa = p ? [p] : [];
    const [units, occupancy, cartera, pqrs, requests, visitsToday, bookings, pets, debtors, notices, pending] = await Promise.all([
      db.first(`SELECT COUNT(*) AS units, COALESCE(SUM(residents), 0) AS residents, COUNT(DISTINCT property_id) AS properties FROM units u WHERE u.business_id = ?${up}`, c.businessId, ...pa),
      db.all(`SELECT occupancy, COUNT(*) AS n FROM units u WHERE u.business_id = ?${up} GROUP BY occupancy`, c.businessId, ...pa),
      db.first(
        `SELECT COALESCE(SUM(CASE WHEN ch.paid_at IS NULL AND ch.due_date < ? THEN ch.amount END), 0) AS overdue,
                COALESCE(SUM(CASE WHEN ch.paid_at >= ? THEN ch.amount END), 0) AS collected_month,
                COALESCE(SUM(CASE WHEN substr(ch.due_date, 1, 7) = ? THEN ch.amount END), 0) AS billed_month,
                COUNT(DISTINCT CASE WHEN ch.paid_at IS NULL AND ch.due_date < ? THEN ch.unit_id END) AS debtors
           FROM charges ch JOIN units u ON u.id = ch.unit_id WHERE ch.business_id = ?${up}`,
        t, t.slice(0, 8) + '01', t.slice(0, 7), t, c.businessId, ...pa,
      ),
      db.first(`SELECT COUNT(*) AS open, COUNT(CASE WHEN priority = 'alta' THEN 1 END) AS urgent FROM pqrs WHERE business_id = ? AND status <> 'closed'${pp}`, c.businessId, ...pa),
      db.first(`SELECT COUNT(*) AS pending FROM requests WHERE business_id = ? AND status = 'pending'${pp}`, c.businessId, ...pa),
      db.first(`SELECT COUNT(*) AS n FROM requests WHERE business_id = ? AND kind = 'visita' AND substr(scheduled_at, 1, 10) = ?${pp}`, c.businessId, t, ...pa),
      db.all(
        `SELECT b.id, b.date, b.start_time, b.end_time, b.status, b.holder, a.name AS amenity, u.tower, u.number
           FROM bookings b JOIN amenities a ON a.id = b.amenity_id LEFT JOIN units u ON u.id = b.unit_id
          WHERE b.business_id = ? AND b.date >= ? AND b.status IN ('pending','approved')${p ? ' AND a.property_id = ?' : ''}
          ORDER BY b.date, b.start_time LIMIT 5`,
        c.businessId, t, ...pa,
      ),
      db.first(`SELECT COUNT(*) AS n FROM pets pt JOIN units u ON u.id = pt.unit_id WHERE pt.business_id = ?${up}`, c.businessId, ...pa),
      db.all(`SELECT * FROM (${UNIT_DEBT_SQL} WHERE u.business_id = ?${up}) WHERE overdue > 0 ORDER BY overdue DESC LIMIT 5`, c.businessId, ...pa),
      db.all(
        `SELECT id, title, category, created_at FROM notices WHERE business_id = ? AND status = 'published'${p ? ' AND (property_id IS NULL OR property_id = ?)' : ''}
          ORDER BY created_at DESC LIMIT 4`,
        c.businessId, ...pa,
      ),
      db.all(
        `SELECT rq.id, rq.kind, rq.title, rq.scheduled_at, u.tower, u.number FROM requests rq LEFT JOIN units u ON u.id = rq.unit_id
          WHERE rq.business_id = ? AND rq.status = 'pending'${p ? ' AND rq.property_id = ?' : ''} ORDER BY COALESCE(rq.scheduled_at, rq.created_at) LIMIT 5`,
        c.businessId, ...pa,
      ),
    ]);
    return json({
      ...units,
      occupancy: Object.fromEntries(occupancy.map((o) => [o.occupancy, o.n])),
      cartera,
      pqrs,
      requests: { ...requests, visitsToday: visitsToday.n },
      pets: pets.n,
      bookings, debtors, notices, pending,
    });
  });

  // Nombre y logo de una administración para su login (/<slug>/admin/login), sin sesión.
  r.get('/api/public/negocio/:slug', 'public', async (c) => {
    const b = isValidSlug(c.params.slug) && (await businessBySlug(c.env, c.params.slug));
    if (!b || b.status !== 'active') throw new HttpError(404, 'Administración no encontrada');
    return json({ name: b.name, slug: b.slug, logo: brandUrl(b.logo_key) });
  });
}
