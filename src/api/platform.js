// Plataforma: Diwilo Web crea negocios (administraciones), invita propietarios y fija hasta cuándo
// está paga la suscripción. Nivel 'platform' = Authorization: Bearer PLATFORM_KEY.
// Contrato común a las apps de Diwilo (pedidos, nutrición, citas, residentes):
//   GET    /api/platform/businesses
//   POST   /api/platform/businesses                 { name, slug?, owner_email, owner_name?, paid_until }
//   GET    /api/platform/businesses/:id
//   PATCH  /api/platform/businesses/:id             { name?, slug?, paid_until? }
//          slug = dirección /<slug>; la anterior queda como alias y redirige a la nueva.
//   POST   /api/platform/businesses/:id/users       { email, name?, role: owner|admin|staff } -> invite_path
//          Un solo propietario por negocio: role 'owner' le pasa la propiedad (el anterior queda como administrador).
//   DELETE /api/platform/businesses/:id/users/:userId   (el propietario no se quita: primero se pasa la propiedad)
import { json, readJson, HttpError, str, oneOf, email } from '../lib/http.js';
import { globalDb, uuid } from '../lib/db.js';
import { createInvite, invitePath, isExpired } from '../lib/auth.js';
import { RESERVED, validateSlug } from '../lib/tenant.js';
import { brandUrl } from './files.js';

const slugify = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

function paidUntil(v) {
  if (v === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) throw new HttpError(400, 'Fecha de pago inválida');
  return v;
}

async function listBusinesses(env, id, origin = '') {
  const db = globalDb(env);
  const where = id ? 'WHERE b.id = ?' : '';
  const args = id ? [id] : [];
  const [businesses, users] = await Promise.all([
    db.all(`SELECT b.id, b.name, b.slug, b.status, b.created_at, b.paid_until, b.logo_key FROM businesses b ${where} ORDER BY b.created_at`, ...args),
    db.all(
      `SELECT m.business_id, u.id, u.email, u.name, m.role, (u.pin_hash IS NOT NULL) AS has_password
         FROM memberships m JOIN users u ON u.id = m.user_id ${id ? 'WHERE m.business_id = ?' : ''}
        ORDER BY m.role, u.email`,
      ...args,
    ),
  ]);
  return businesses.map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
    status: b.status,
    created_at: b.created_at.replace(' ', 'T') + 'Z',
    paid_until: b.paid_until || null,
    read_only: isExpired(b.paid_until),
    admin_url: `${origin}/${b.slug}/admin`,
    logo_url: b.logo_key ? origin + brandUrl(b.logo_key) : null,
    users: users.filter((u) => u.business_id === b.id).map((u) => ({
      id: u.id, email: u.email, name: u.name, role: u.role,
      status: u.has_password ? 'active' : 'invited',
      invite_path: null, // solo se guarda el hash: se ve al generarlo
    })),
  }));
}

// Crea el usuario si no existe y lo agrega (o cambia de rol) en el negocio.
async function addMember(env, businessId, mail, name, role) {
  const db = globalDb(env);
  let user = await db.first('SELECT id FROM users WHERE email = ?', mail);
  if (!user) {
    user = { id: uuid() };
    await db.run('INSERT INTO users (id, email, name) VALUES (?, ?, ?)', user.id, mail, name);
  }
  const prev = await db.first('SELECT role FROM memberships WHERE business_id = ? AND user_id = ?', businessId, user.id);
  if (prev?.role === 'owner' && role !== 'owner') throw new HttpError(409, 'Es el propietario: para cambiarlo, asigna otro propietario');
  await db.batch([
    // Un solo propietario: el anterior pasa a administrador.
    ...(role === 'owner'
      ? [db.prepare(`UPDATE memberships SET role = 'admin' WHERE business_id = ? AND role = 'owner' AND user_id <> ?`, businessId, user.id)]
      : []),
    db.prepare(
      `INSERT INTO memberships (user_id, business_id, role) VALUES (?, ?, ?)
       ON CONFLICT (user_id, business_id) DO UPDATE SET role = excluded.role`,
      user.id, businessId, role,
    ),
  ]);
  return { id: user.id, invite_path: invitePath(await createInvite(env, user.id)) };
}

export function routes(r) {
  r.get('/api/platform/businesses', 'platform', async (c) => json({ businesses: await listBusinesses(c.env, null, c.url.origin) }));

  r.post('/api/platform/businesses', 'platform', async (c) => {
    const body = await readJson(c.req);
    const name = str(body.name, { required: true, max: 120, label: 'Nombre' });
    let slug = slugify(str(body.slug, { max: 50 }) || name);
    if (slug.length < 2) throw new HttpError(400, 'Identificador inválido');
    if (RESERVED.has(slug)) slug = `${slug}-ph`;  // /<slug> no puede chocar con rutas de la app
    const ownerEmail = email(body.owner_email, { required: true, label: 'Correo del propietario' });
    const db = globalDb(c.env);
    if (await db.first('SELECT 1 FROM businesses WHERE slug = ?', slug)) throw new HttpError(409, 'Ya existe un negocio con ese identificador');
    const id = uuid();
    await db.run(
      'INSERT INTO businesses (id, name, slug, email, paid_until) VALUES (?, ?, ?, ?, ?)',
      id, name, slug, ownerEmail, paidUntil(body.paid_until ?? null),
    );
    const owner = await addMember(c.env, id, ownerEmail, str(body.owner_name, { max: 100 }), 'owner');
    return json({ id, slug, invite_path: owner.invite_path }, 201);
  });

  r.get('/api/platform/businesses/:id', 'platform', async (c) => {
    const [b] = await listBusinesses(c.env, c.params.id, c.url.origin);
    if (!b) throw new HttpError(404, 'Negocio no encontrado');
    return json(b);
  });

  r.patch('/api/platform/businesses/:id', 'platform', async (c) => {
    const body = await readJson(c.req);
    const db = globalDb(c.env);
    if (!(await db.first('SELECT 1 FROM businesses WHERE id = ?', c.params.id))) throw new HttpError(404, 'Negocio no encontrado');
    const stmts = [];
    if (body.name !== undefined) {
      stmts.push(db.prepare(`UPDATE businesses SET name = ?, updated_at = datetime('now') WHERE id = ?`,
        str(body.name, { required: true, max: 120, label: 'Nombre' }), c.params.id));
    }
    if (body.slug !== undefined) {
      const slug = validateSlug(body.slug);
      const current = await db.first('SELECT slug FROM businesses WHERE id = ?', c.params.id);
      if (slug !== current.slug) {
        if (await db.first('SELECT 1 FROM businesses WHERE slug = ? AND id <> ?', slug, c.params.id)) throw new HttpError(409, 'Ese identificador ya existe');
        if (await db.first('SELECT 1 FROM business_slug_aliases WHERE slug = ? AND business_id <> ?', slug, c.params.id)) {
          throw new HttpError(409, 'Esa dirección la usó antes otro negocio');
        }
        stmts.push(
          db.prepare(`UPDATE businesses SET slug = ?, updated_at = datetime('now') WHERE id = ?`, slug, c.params.id),
          // La dirección anterior sigue funcionando: redirige a la nueva.
          db.prepare('INSERT OR REPLACE INTO business_slug_aliases (slug, business_id) VALUES (?, ?)', current.slug, c.params.id),
          db.prepare('DELETE FROM business_slug_aliases WHERE slug = ?', slug),
        );
      }
    }
    if (body.paid_until !== undefined) {
      stmts.push(db.prepare(`UPDATE businesses SET paid_until = ?, updated_at = datetime('now') WHERE id = ?`,
        paidUntil(body.paid_until), c.params.id));
    }
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  });

  r.post('/api/platform/businesses/:id/users', 'platform', async (c) => {
    const body = await readJson(c.req);
    if (!(await globalDb(c.env).first('SELECT 1 FROM businesses WHERE id = ?', c.params.id))) throw new HttpError(404, 'Negocio no encontrado');
    const member = await addMember(
      c.env, c.params.id,
      email(body.email, { required: true, label: 'Correo' }),
      str(body.name, { max: 100 }),
      oneOf(body.role, ['owner', 'admin', 'staff'], { label: 'Rol', fallback: 'staff' }),
    );
    return json(member, 201);
  });

  r.delete('/api/platform/businesses/:id/users/:userId', 'platform', async (c) => {
    const db = globalDb(c.env);
    const m = await db.first('SELECT role FROM memberships WHERE business_id = ? AND user_id = ?', c.params.id, c.params.userId);
    if (m?.role === 'owner') throw new HttpError(409, 'No se puede quitar al propietario: primero asigna otro propietario');
    await db.batch([
      db.prepare('DELETE FROM memberships WHERE business_id = ? AND user_id = ?', c.params.id, c.params.userId),
      db.prepare('DELETE FROM sessions WHERE business_id = ? AND user_id = ?', c.params.id, c.params.userId),
    ]);
    return json({ ok: true });
  });
}
