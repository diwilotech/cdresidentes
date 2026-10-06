// Portal de propietarios y residentes (/<slug>/portal): comunicados, cartera y cuenta de cobro de sus unidades,
// datos de la unidad y del conjunto, registro de mascotas y reservas de zonas comunes.
// Nivel 'resident': c.units trae solo las unidades vinculadas a la persona; todo se filtra por ellas.
import { json, readJson, str, num, oneOf, date, HttpError } from '../lib/http.js';
import { tenantDb, globalDb, nowIso } from '../lib/db.js';
import {
  normalizeDoc, createPortalSession, portalCookie, loadPortalSession, destroyPortalSession,
  loadSession, destroySession, sessionCookie, timingSafeEqualHex, sha256Hex,
} from '../lib/auth.js';
import { businessBySlug } from '../lib/tenant.js';
import { pick, insertRow, updateRow, deleteRow, getRow } from '../lib/crud.js';
import { today } from '../lib/time.js';
import { CONCEPTS } from './charges.js';
import { getBilling, buildStatements } from './billing.js';
import { priceFor, assertFree } from './bookings.js';
import { brandUrl, saveUpload, serveFile } from './files.js';
import { unitLabel } from './units.js';

const marks = (list) => list.map(() => '?').join(', ');
const unitIds = (c) => c.units.map((u) => u.unit_id);
const propertyIds = (c) => [...new Set(c.units.map((u) => u.property_id))];

// Unidad pedida (?unit= o en el cuerpo); debe ser de la persona. Con una sola unidad se toma esa.
function unitOf(c, id) {
  const u = id ? c.units.find((x) => x.unit_id === id) : c.units.length === 1 ? c.units[0] : null;
  if (!u) throw new HttpError(id ? 403 : 400, id ? 'Esa unidad no es tuya' : 'Elige una unidad');
  return u;
}

const PET = {
  name: (v) => str(v, { required: true, max: 80, label: 'Nombre' }),
  species: (v) => oneOf(v, ['perro', 'gato', 'ave', 'otro'], { label: 'Especie', fallback: 'perro' }),
  breed: (v) => str(v, { max: 80, label: 'Raza' }),
  potentially_dangerous: (v) => (v === true || v === 1 || v === '1' ? 1 : 0),
  vaccinated_until: (v) => date(v, { label: 'Vacunas al día hasta' }),
  notes: (v) => str(v, { max: 1000, label: 'Notas' }),
};

const BOOKING = {
  amenity_id: (v) => str(v, { required: true, max: 40, label: 'Zona' }),
  date: (v) => date(v, { required: true, label: 'Fecha' }),
  start_time: (v) => hhmm(v, 'Hora de inicio'),
  end_time: (v) => hhmm(v, 'Hora de fin'),
  notes: (v) => str(v, { max: 500, label: 'Notas' }),
};
function hhmm(v, label) {
  const s = str(v, { required: true, max: 5, label });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpError(400, `${label} no es válida`);
  return s;
}

async function myPet(c, id) {
  const pet = await getRow(c, 'pets', id, 'Mascota');
  unitOf(c, pet.unit_id);
  return pet;
}

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const isoIn = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');

async function activeBusiness(c) {
  const b = await businessBySlug(c.env, c.params.slug);
  if (!b || b.status !== 'active') throw new HttpError(404, 'No encontramos esta administración.');
  return b;
}

export function routes(r) {
  // ---------- ingreso con apartamento + cédula (público) ----------

  // Conjuntos y unidades para elegir el apartamento (sin nombres ni datos personales).
  r.get('/api/public/portal/:slug/units', 'public', async (c) => {
    const b = await activeBusiness(c);
    const db = globalDb(c.env);
    const [properties, units] = await Promise.all([
      db.all("SELECT id, name FROM properties WHERE business_id = ? AND status = 'active' ORDER BY name", b.id),
      db.all(
        `SELECT u.id, u.property_id, u.tower, u.number, u.kind FROM units u JOIN properties p ON p.id = u.property_id
          WHERE u.business_id = ? AND p.status = 'active' ORDER BY u.tower, CAST(u.number AS INTEGER), u.number`,
        b.id,
      ),
    ]);
    return json({ business: { name: b.name, logo: brandUrl(b.logo_key) }, properties, units });
  });

  r.post('/api/public/portal/:slug/login', 'public', async (c) => {
    const b = await activeBusiness(c);
    const body = await readJson(c.req);
    const db = globalDb(c.env);
    const unit = await db.first('SELECT id, owner_doc FROM units WHERE business_id = ? AND id = ?', b.id, String(body.unit_id || ''));
    if (!unit) throw new HttpError(400, 'Elige tu apartamento');
    const doc = normalizeDoc(body.doc);
    if (!doc) throw new HttpError(400, 'Escribe la cédula del propietario');
    if (!normalizeDoc(unit.owner_doc)) {
      throw new HttpError(400, 'Esta unidad no tiene la cédula del propietario registrada. Pídele a la administración que la registre.', 'NO_DOC');
    }
    const att = await db.first('SELECT fails, locked_until FROM portal_logins WHERE unit_id = ?', unit.id);
    if (att?.locked_until && att.locked_until > nowIso()) {
      throw new HttpError(429, 'Demasiados intentos con esta unidad. Intenta de nuevo en unos minutos.', 'LOCKED');
    }
    if (!timingSafeEqualHex(await sha256Hex(doc), await sha256Hex(normalizeDoc(unit.owner_doc)))) {
      const fails = (att?.fails || 0) + 1;
      const lock = fails >= MAX_FAILS ? isoIn(LOCK_MINUTES * 60 * 1000) : null;
      await db.run(
        `INSERT INTO portal_logins (unit_id, business_id, fails, locked_until) VALUES (?, ?, ?, ?)
         ON CONFLICT (unit_id) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`,
        unit.id, b.id, lock ? 0 : fails, lock,
      );
      throw new HttpError(401, lock ? 'Cédula incorrecta. La unidad quedó bloqueada 15 minutos.' : 'La cédula no coincide con la del propietario de esta unidad', 'BAD_LOGIN');
    }
    if (att) await db.run('DELETE FROM portal_logins WHERE unit_id = ?', unit.id);
    const token = await createPortalSession(c.env, b.id, unit.id, doc);
    return json({ ok: true }, 200, { 'set-cookie': portalCookie(token, c.req) });
  });

  // Cierra la sesión del portal (cédula y, si la hay, la de correo).
  r.post('/api/public/portal/logout', 'public', async (c) => {
    const [ps, s] = await Promise.all([loadPortalSession(c.req, c.env), loadSession(c.req, c.env)]);
    if (ps) await destroyPortalSession(c.env, ps.session_id);
    if (s) await destroySession(c.env, s.session_id);
    const res = json({ ok: true });
    res.headers.append('set-cookie', portalCookie(null, c.req));
    if (s) res.headers.append('set-cookie', sessionCookie(null, c.req));
    return res;
  });

  // Sesión del portal: persona, administración y sus unidades.
  r.get('/api/portal/me', 'resident', async (c) => {
    const db = tenantDb(c);
    const ids = unitIds(c);
    const [units, biz, billing, portals, member] = await Promise.all([
      db.all(
        `SELECT u.id, u.tower, u.number, u.kind, u.property_id, p.name AS property_name, p.logo_key
           FROM units u JOIN properties p ON p.id = u.property_id
          WHERE u.business_id = ? AND u.id IN (${marks(ids)}) ORDER BY p.name, u.tower, u.number`,
        c.businessId, ...ids,
      ),
      db.first('SELECT name, slug, email, phone, logo_key FROM businesses WHERE id = ? /* business_id */', c.businessId),
      getBilling(c),
      globalDb(c.env).all(
        `SELECT DISTINCT b.name, b.slug FROM residents r JOIN businesses b ON b.id = r.business_id
          WHERE r.user_id = ? AND b.status = 'active' ORDER BY b.name`,
        c.user.id,
      ),
      globalDb(c.env).first('SELECT 1 AS ok FROM memberships WHERE user_id = ? AND business_id = ?', c.user.id, c.businessId),
    ]);
    const rel = Object.fromEntries(c.units.map((u) => [u.unit_id, u.relation]));
    return json({
      user: c.user,
      business: { name: biz.name, slug: biz.slug, email: biz.email, phone: biz.phone, logo: brandUrl(biz.logo_key) },
      units: units.map(({ logo_key, ...u }) => ({ ...u, label: unitLabel(u), relation: rel[u.id], property_logo: brandUrl(logo_key) })),
      concepts: CONCEPTS,
      billing: { concepts: billing.concepts, due_day: billing.due_day, interest_rate: billing.interest_rate },
      portals,
      isStaff: !!member,
      login: c.portalSession ? 'doc' : 'user',
      readOnly: !!c.business.paid_until && c.business.paid_until < today(),
    });
  });

  // Inicio: saldo de la unidad, últimos comunicados, próximas reservas y mascotas.
  r.get('/api/portal/home', 'resident', async (c) => {
    const u = unitOf(c, c.url.searchParams.get('unit'));
    const db = tenantDb(c);
    const t = today();
    const [bal, notices, bookings, pets] = await Promise.all([
      db.first(
        `SELECT COALESCE(SUM(amount), 0) AS balance,
                COALESCE(SUM(CASE WHEN due_date < ? THEN amount END), 0) AS overdue,
                MIN(CASE WHEN due_date >= ? THEN due_date END) AS next_due
           FROM charges WHERE business_id = ? AND unit_id = ? AND paid_at IS NULL`,
        t, t, c.businessId, u.unit_id,
      ),
      db.all(
        `SELECT id, title, category, created_at, substr(body, 1, 220) AS excerpt FROM notices
          WHERE business_id = ? AND status = 'published' AND (property_id IS NULL OR property_id = ?)
          ORDER BY created_at DESC LIMIT 3`,
        c.businessId, u.property_id,
      ),
      db.all(
        `SELECT b.id, b.date, b.start_time, b.end_time, b.status, a.name AS amenity_name FROM bookings b JOIN amenities a ON a.id = b.amenity_id
          WHERE b.business_id = ? AND b.unit_id = ? AND b.date >= ? AND b.status IN ('pending','approved') ORDER BY b.date, b.start_time LIMIT 5`,
        c.businessId, u.unit_id, t,
      ),
      db.first('SELECT COUNT(*) AS n FROM pets WHERE business_id = ? AND unit_id = ?', c.businessId, u.unit_id),
    ]);
    const last = await db.first('SELECT MAX(paid_at) AS d FROM charges WHERE business_id = ? AND unit_id = ?', c.businessId, u.unit_id);
    return json({ ...bal, last_paid: last?.d || null, notices, bookings, pets: pets.n });
  });

  // ---------- comunicados ----------

  r.get('/api/portal/notices', 'resident', async (c) => {
    const props = propertyIds(c);
    const items = await tenantDb(c).all(
      `SELECT n.id, n.title, n.category, n.body, n.created_at, n.property_id, p.name AS property_name,
              (SELECT COUNT(*) FROM files f WHERE f.business_id = n.business_id AND f.ref_type = 'notice' AND f.ref_id = n.id) AS files
         FROM notices n LEFT JOIN properties p ON p.id = n.property_id
        WHERE n.business_id = ? AND n.status = 'published' AND (n.property_id IS NULL OR n.property_id IN (${marks(props)}))
        ORDER BY n.created_at DESC LIMIT 100`,
      c.businessId, ...props,
    );
    return json({ items });
  });

  r.get('/api/portal/notices/:id/files', 'resident', async (c) => {
    const props = propertyIds(c);
    const n = await tenantDb(c).first(
      `SELECT id FROM notices WHERE business_id = ? AND id = ? AND status = 'published' AND (property_id IS NULL OR property_id IN (${marks(props)}))`,
      c.businessId, c.params.id, ...props,
    );
    if (!n) throw new HttpError(404, 'Comunicado no encontrado');
    const items = await tenantDb(c).all(
      `SELECT id, name, content_type FROM files WHERE business_id = ? AND ref_type = 'notice' AND ref_id = ? ORDER BY created_at`,
      c.businessId, n.id,
    );
    return json({ items });
  });

  // ---------- cartera ----------

  // Cobros pendientes y pagos de los últimos 24 meses de una unidad.
  r.get('/api/portal/charges', 'resident', async (c) => {
    const u = unitOf(c, c.url.searchParams.get('unit'));
    const [items, billing] = await Promise.all([
      tenantDb(c).all(
        `SELECT id, concept, period, description, amount, due_date, paid_at, payment_ref FROM charges
          WHERE business_id = ? AND unit_id = ? AND (paid_at IS NULL OR paid_at >= date('now', '-24 months'))
          ORDER BY paid_at IS NOT NULL, due_date DESC, concept`,
        c.businessId, u.unit_id,
      ),
      getBilling(c),
    ]);
    return json({ items, today: today(), concepts: CONCEPTS, billing: { concepts: billing.concepts, interest_rate: billing.interest_rate, due_day: billing.due_day } });
  });

  // Datos de la cuenta de cobro (el PDF se arma en el navegador con cuenta-cobro.js, igual que en el panel).
  r.get('/api/portal/statements', 'resident', async (c) => {
    const u = unitOf(c, c.url.searchParams.get('unit'));
    return buildStatements(c, { unitId: u.unit_id });
  });

  // ---------- mi unidad ----------

  r.get('/api/portal/unit', 'resident', async (c) => {
    const ru = unitOf(c, c.url.searchParams.get('unit'));
    const db = tenantDb(c);
    const unit = await getRow(c, 'units', ru.unit_id, 'Unidad');
    const [prop, docs, biz, residents] = await Promise.all([
      db.first('SELECT id, name, nit, address, city, phone, email, towers, payment_info, logo_key FROM properties WHERE business_id = ? AND id = ?', c.businessId, unit.property_id),
      db.all(`SELECT id, name, content_type, size, created_at FROM files WHERE business_id = ? AND ref_type = 'property' AND ref_id = ? ORDER BY created_at DESC`, c.businessId, unit.property_id),
      db.first('SELECT name, email, phone FROM businesses WHERE id = ? /* business_id */', c.businessId),
      db.all(
        `SELECT us.name, us.email, r.relation FROM residents r JOIN users us ON us.id = r.user_id
          WHERE r.business_id = ? AND r.unit_id = ? ORDER BY r.relation, us.name`,
        c.businessId, ru.unit_id,
      ),
    ]);
    const { logo_key, ...property } = prop;
    const { notes, ...u } = unit; // las notas internas de la administración no se muestran
    return json({ unit: { ...u, label: unitLabel(u) }, relation: ru.relation, property: { ...property, logo: brandUrl(logo_key) }, docs, business: biz, residents });
  });

  // La persona actualiza su celular, el número de habitantes y las placas.
  r.put('/api/portal/unit/:id', 'resident', async (c) => {
    const ru = unitOf(c, c.params.id);
    const body = await readJson(c.req);
    const data = pick(body, {
      phone: (v) => str(v, { max: 30, label: 'Celular' }),
      residents: (v) => num(v, { min: 0, max: 50, label: 'Habitantes' }),
      vehicles: (v) => str(v, { max: 120, label: 'Vehículos' }),
    }, { partial: true });
    // El celular es el del propietario o el del arrendatario, según quién sea la persona.
    if ('phone' in data) { data[ru.relation === 'tenant' ? 'tenant_phone' : 'owner_phone'] = data.phone; delete data.phone; }
    await updateRow(c, 'units', ru.unit_id, data);
    return json({ ok: true });
  });

  // Archivos que la persona puede ver: documentos de su conjunto, adjuntos de comunicados visibles y fotos de sus mascotas.
  r.get('/api/portal/files/:id', 'resident', async (c) => {
    const db = tenantDb(c);
    const f = await db.first('SELECT * FROM files WHERE business_id = ? AND id = ?', c.businessId, c.params.id);
    const props = propertyIds(c);
    let ok = false;
    if (f?.ref_type === 'property') ok = props.includes(f.ref_id);
    else if (f?.ref_type === 'pet') ok = !!(await db.first(`SELECT 1 FROM pets WHERE business_id = ? AND id = ? AND unit_id IN (${marks(unitIds(c))})`, c.businessId, f.ref_id, ...unitIds(c)));
    else if (f?.ref_type === 'notice') {
      ok = !!(await db.first(
        `SELECT 1 FROM notices WHERE business_id = ? AND id = ? AND status = 'published' AND (property_id IS NULL OR property_id IN (${marks(props)}))`,
        c.businessId, f.ref_id, ...props,
      ));
    }
    if (!ok) throw new HttpError(404, 'Archivo no encontrado');
    return serveFile(c, f);
  });

  // ---------- mascotas ----------

  r.get('/api/portal/pets', 'resident', async (c) => {
    const ids = unitIds(c);
    const items = await tenantDb(c).all(
      `SELECT pt.*, u.tower, u.number,
              (SELECT f.id FROM files f WHERE f.business_id = pt.business_id AND f.ref_type = 'pet' AND f.ref_id = pt.id
                 AND f.content_type LIKE 'image/%' ORDER BY f.created_at DESC LIMIT 1) AS photo_id
         FROM pets pt JOIN units u ON u.id = pt.unit_id
        WHERE pt.business_id = ? AND pt.unit_id IN (${marks(ids)}) ORDER BY u.tower, u.number, pt.name`,
      c.businessId, ...ids,
    );
    return json({ items });
  });

  r.post('/api/portal/pets', 'resident', async (c) => {
    const body = await readJson(c.req);
    const u = unitOf(c, body.unit_id);
    const id = await insertRow(c, 'pets', { ...pick(body, PET), unit_id: u.unit_id, created_by: c.user.id });
    return json({ id }, 201);
  });

  r.put('/api/portal/pets/:id', 'resident', async (c) => {
    await myPet(c, c.params.id);
    await updateRow(c, 'pets', c.params.id, pick(await readJson(c.req), PET, { partial: true }), { touch: false });
    return json({ ok: true });
  });

  r.delete('/api/portal/pets/:id', 'resident', async (c) => {
    await myPet(c, c.params.id);
    const db = tenantDb(c);
    const files = await db.all(`SELECT r2_key FROM files WHERE business_id = ? AND ref_type = 'pet' AND ref_id = ?`, c.businessId, c.params.id);
    await deleteRow(c, 'pets', c.params.id);
    await db.run(`DELETE FROM files WHERE business_id = ? AND ref_type = 'pet' AND ref_id = ?`, c.businessId, c.params.id);
    if (files.length) c.ctx.waitUntil(c.env.FILES.delete(files.map((f) => f.r2_key)));
    return json({ ok: true });
  });

  // Foto o carné de vacunas de la mascota (imagen).
  r.post('/api/portal/pets/:id/photo', 'resident', async (c) => {
    await myPet(c, c.params.id);
    return json(await saveUpload(c, 'pet', c.params.id, { imagesOnly: true }), 201);
  });

  // ---------- reservas ----------

  r.get('/api/portal/amenities', 'resident', async (c) => {
    const props = propertyIds(c);
    const items = await tenantDb(c).all(
      `SELECT a.id, a.property_id, a.name, a.fee, a.fee_unit, a.capacity, a.rules, p.name AS property_name
         FROM amenities a JOIN properties p ON p.id = a.property_id
        WHERE a.business_id = ? AND a.active = 1 AND a.property_id IN (${marks(props)}) ORDER BY p.name, a.name`,
      c.businessId, ...props,
    );
    return json({ items });
  });

  // Ocupación de una zona en un mes (sin datos de las demás unidades).
  r.get('/api/portal/availability', 'resident', async (c) => {
    const sp = c.url.searchParams;
    const month = sp.get('month') || today().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Mes inválido');
    const a = await getRow(c, 'amenities', sp.get('amenity') || '', 'Zona');
    if (!propertyIds(c).includes(a.property_id)) throw new HttpError(404, 'Zona no encontrada');
    const ids = unitIds(c);
    const items = await tenantDb(c).all(
      `SELECT date, start_time, end_time, status, (unit_id IN (${marks(ids)})) AS mine FROM bookings
        WHERE business_id = ? AND amenity_id = ? AND substr(date, 1, 7) = ? AND status IN ('pending','approved')
        ORDER BY date, start_time`,
      ...ids, c.businessId, a.id, month,
    );
    return json({ items, month });
  });

  r.get('/api/portal/bookings', 'resident', async (c) => {
    const ids = unitIds(c);
    const items = await tenantDb(c).all(
      `SELECT b.id, b.amenity_id, b.unit_id, b.date, b.start_time, b.end_time, b.amount, b.paid, b.status, b.notes, b.created_at,
              a.name AS amenity_name, u.tower, u.number
         FROM bookings b JOIN amenities a ON a.id = b.amenity_id JOIN units u ON u.id = b.unit_id
        WHERE b.business_id = ? AND b.unit_id IN (${marks(ids)})
        ORDER BY b.date DESC, b.start_time DESC LIMIT 200`,
      c.businessId, ...ids,
    );
    return json({ items, today: today() });
  });

  // Solicitud de reserva: queda pendiente hasta que la administración la apruebe.
  r.post('/api/portal/bookings', 'resident', async (c) => {
    const body = await readJson(c.req);
    const u = unitOf(c, body.unit_id);
    const data = pick(body, BOOKING);
    const amenity = await getRow(c, 'amenities', data.amenity_id, 'Zona');
    if (!amenity.active || amenity.property_id !== u.property_id) throw new HttpError(400, 'Esa zona no es de tu conjunto o no está disponible');
    if (data.date < today()) throw new HttpError(400, 'La fecha ya pasó');
    await assertFree(c, data);
    const id = await insertRow(c, 'bookings', {
      ...data,
      unit_id: u.unit_id,
      holder: c.user.name || c.user.email,
      amount: priceFor(amenity, data.start_time, data.end_time),
      status: 'pending',
      created_by: c.user.id,
    });
    return json({ id }, 201);
  });

  r.post('/api/portal/bookings/:id/cancel', 'resident', async (c) => {
    const b = await getRow(c, 'bookings', c.params.id, 'Reserva');
    unitOf(c, b.unit_id);
    if (!['pending', 'approved'].includes(b.status) || b.date < today()) throw new HttpError(400, 'Esta reserva ya no se puede cancelar');
    await updateRow(c, 'bookings', b.id, { status: 'cancelled' }, { touch: false });
    return json({ ok: true });
  });
}
