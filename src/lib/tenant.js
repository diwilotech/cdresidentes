// Multi-tenant por ruta: cada administración vive en /<slug> (p. ej. /altos-de-la-colina).
//   /<slug>           redirige al panel
//   /<slug>/admin/…   panel (la API recibe el negocio en el encabezado x-business)
import { HttpError } from './http.js';
import { globalDb } from './db.js';

// Primeros segmentos que no pueden ser el nombre de un negocio.
export const RESERVED = new Set([
  'admin', 'api', 'assets', 'login', 'logout', 'static', 'www', 'app',
  'favicon.ico', 'robots.txt', 'cdn-cgi', 'platform', 'public', 'diwilo',
]);
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export const isValidSlug = (s) => SLUG_RE.test(s) && !RESERVED.has(s);

export function slugFromPath(pathname) {
  const seg = pathname.split('/')[1] || '';
  return isValidSlug(seg) ? seg : null;
}

export function businessBySlug(env, slug) {
  return globalDb(env).first('SELECT id, name, slug, status, email, phone, logo_key FROM businesses WHERE slug = ?', slug);
}

export function validateSlug(raw) {
  const slug = String(raw || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'La dirección solo puede tener letras minúsculas, números y guiones (2 a 50).');
  if (RESERVED.has(slug)) throw new HttpError(400, 'Esa dirección está reservada. Elige otra.');
  return slug;
}

// Negocio por defecto de una sesión: el activo en la sesión o el primero del usuario.
export async function defaultSlug(env, session) {
  const row = await globalDb(env).first(
    `SELECT b.slug FROM memberships m JOIN businesses b ON b.id = m.business_id
      WHERE m.user_id = ? AND b.status = 'active'
      ORDER BY (b.id = ?) DESC, b.name LIMIT 1`,
    session.user_id, session.business_id || '',
  );
  return row?.slug || null;
}

export async function isMember(env, userId, slug) {
  return !!(await globalDb(env).first(
    `SELECT 1 FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = ? AND b.slug = ? AND b.status = 'active'`,
    userId, slug,
  ));
}
