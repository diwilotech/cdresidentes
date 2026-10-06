// Unidades privadas: directorio de copropietarios y arrendatarios.
import { json, readJson, str, num, email, oneOf, HttpError } from '../lib/http.js';
import { tenantDb, globalDb, uuid } from '../lib/db.js';
import { createInvite } from '../lib/auth.js';
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
         (SELECT MIN(ch.due_date) FROM charges ch WHERE ch.business_id = u.business_id AND ch.unit_id = u.id AND ch.paid_at IS NULL AND ch.due_date < date('now', '-5 hours')) AS oldest_due,
         (SELECT COUNT(*) FROM residents r WHERE r.business_id = u.business_id AND r.unit_id = u.id) AS portal_users
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

  // ---------- acceso al portal de propietarios ----------

  r.get('/api/admin/units/:id/access', 'tenant', async (c) => {
    await getRow(c, 'units', c.params.id, 'Unidad');
    const items = await tenantDb(c).all(
      `SELECT us.id, us.email, us.name, r.relation, r.created_at, (us.pin_hash IS NOT NULL) AS has_password
         FROM residents r JOIN users us ON us.id = r.user_id
        WHERE r.business_id = ? AND r.unit_id = ? ORDER BY r.relation, us.email`,
      c.businessId, c.params.id,
    );
    return json({ items, portalUrl: portalUrl(c) });
  });

  // Da acceso a una persona (por correo). Si aún no tiene contraseña recibe un link para crearla.
  r.post('/api/admin/units/:id/access', 'manager', async (c) => {
    const unit = await getRow(c, 'units', c.params.id, 'Unidad');
    const body = await readJson(c.req);
    const relation = oneOf(body.relation, ['owner', 'tenant'], { label: 'Relación', fallback: 'owner' });
    const mail = email(body.email || (relation === 'tenant' ? unit.tenant_email : unit.owner_email), { required: true, label: 'Correo' });
    const name = str(body.name, { max: 100, label: 'Nombre' }) || (relation === 'tenant' ? unit.tenant_name : unit.owner_name);
    const gdb = globalDb(c.env);
    let user = await gdb.first('SELECT id, pin_hash, invite_hash FROM users WHERE email = ?', mail);
    if (!user) {
      user = { id: uuid() };
      await gdb.run('INSERT INTO users (id, email, name) VALUES (?, ?, ?)', user.id, mail, name);
    }
    await tenantDb(c).run(
      `INSERT INTO residents (user_id, business_id, unit_id, relation) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, unit_id) DO UPDATE SET relation = excluded.relation`,
      user.id, c.businessId, unit.id, relation,
    );
    // Un link nuevo invalida el anterior: si ya tiene uno pendiente (p. ej. al darle una segunda unidad) se conserva.
    const invitePending = !user.pin_hash && !!user.invite_hash;
    const inviteUrl = user.pin_hash || invitePending ? null : await residentInvite(c, user.id);
    return json({ ok: true, userId: user.id, email: mail, inviteUrl, invitePending, portalUrl: portalUrl(c) }, 201);
  });

  // Link nuevo para crear o restablecer la contraseña (solo si la persona no trabaja en otra administración).
  r.post('/api/admin/units/:id/access/:userId/invite', 'manager', async (c) => {
    const link = await tenantDb(c).first('SELECT 1 FROM residents WHERE business_id = ? AND unit_id = ? AND user_id = ?', c.businessId, c.params.id, c.params.userId);
    if (!link) throw new HttpError(404, 'Esta persona no tiene acceso a la unidad');
    const u = await globalDb(c.env).first(
      `SELECT u.pin_hash,
              (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) +
              (SELECT COUNT(*) FROM residents r WHERE r.user_id = u.id AND r.business_id <> ?) AS others
         FROM users u WHERE u.id = ?`,
      c.businessId, c.params.userId,
    );
    if (u.pin_hash && u.others > 0) {
      throw new HttpError(403, 'Esta persona también usa otra administración de Diwilo. Para restablecer su contraseña, pídelo a Diwilo.');
    }
    return json({ ok: true, inviteUrl: await residentInvite(c, c.params.userId) });
  });

  r.delete('/api/admin/units/:id/access/:userId', 'manager', async (c) => {
    const db = tenantDb(c);
    const res = await db.run('DELETE FROM residents WHERE business_id = ? AND unit_id = ? AND user_id = ?', c.businessId, c.params.id, c.params.userId);
    if (!res.meta.changes) throw new HttpError(404, 'Esta persona no tiene acceso a la unidad');
    return json({ ok: true });
  });
}

const slugOf = (c) => c.session.business_slug;
const portalUrl = (c) => `${c.url.origin}/${slugOf(c)}/portal/`;
// Al crear la contraseña entra directo al portal de esta administración.
async function residentInvite(c, userId) {
  const token = await createInvite(c.env, userId);
  return `${c.url.origin}/?next=${encodeURIComponent(`/${slugOf(c)}/portal/`)}#invite=${token}`;
}
