// Ingreso con correo + contraseña -> sesión en D1 referenciada por cookie HttpOnly.
// La sesión también fija el negocio (tenant) activo.
// Los negocios, sus propietarios y la suscripción los maneja Diwilo Web
// (api/platform.js, nivel 'platform' por RPC).
// La contraseña vive en users.pin_hash/pin_salt (mismo esquema que las demás apps de Diwilo).

import { HttpError, getCookie } from './http.js';
import { globalDb, nowIso } from './db.js';
import { isPlatformCall } from './platform-rpc.js';

export const SESSION_COOKIE = 'cdr_sid';
const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const PBKDF2_ITERATIONS = 100000;
const MIN_PASSWORD = 8;

const enc = new TextEncoder();

// ---------- utilidades cripto ----------

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password, saltHex = randomHex(16)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: toHex(bits), salt: saltHex };
}

// ---------- usuarios ----------

export async function userByEmail(env, email) {
  return globalDb(env).first('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
}

export async function userBusinesses(env, user) {
  return globalDb(env).all(
    `SELECT b.id, b.name, b.slug, b.status, m.role
       FROM memberships m JOIN businesses b ON b.id = m.business_id
      WHERE m.user_id = ? AND b.status = 'active'
      ORDER BY b.name`,
    user.id,
  );
}

// ---------- contraseña ----------

// Lanza 401/429 si no coincide. Mismo mensaje para correo inexistente o clave mala.
export async function checkPassword(env, user, password) {
  const bad = new HttpError(401, 'Correo o contraseña incorrectos', 'BAD_LOGIN');
  if (!user || !user.pin_hash) {
    await hashPassword(String(password || '')); // mismo costo que un intento real
    throw bad;
  }
  if (user.locked_until && user.locked_until > nowIso()) {
    throw new HttpError(429, 'Demasiados intentos. Intenta de nuevo en unos minutos.', 'LOCKED');
  }
  const { hash } = await hashPassword(String(password || ''), user.pin_salt);
  if (timingSafeEqualHex(hash, user.pin_hash)) {
    if (user.failed_pins) await globalDb(env).run('UPDATE users SET failed_pins = 0, locked_until = NULL WHERE id = ?', user.id);
    return;
  }
  const fails = (user.failed_pins || 0) + 1;
  const lock = fails >= MAX_FAILS ? isoIn(LOCK_MINUTES * 60 * 1000) : null;
  await globalDb(env).run('UPDATE users SET failed_pins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock, user.id);
  if (lock) throw new HttpError(401, 'Contraseña incorrecta. Cuenta bloqueada 15 minutos.', 'BAD_LOGIN');
  throw bad;
}

export const isWeakPassword = (password) => String(password || '').length < MIN_PASSWORD;

export async function setPassword(env, userId, password) {
  if (isWeakPassword(password) || String(password).length > 200) {
    throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
  }
  const { hash, salt } = await hashPassword(String(password));
  await globalDb(env).run(
    'UPDATE users SET pin_hash = ?, pin_salt = ?, failed_pins = 0, locked_until = NULL, invite_hash = NULL WHERE id = ?',
    hash, salt, userId,
  );
}

// ---------- invitaciones ----------
// Link /#invite=<token> (login genérico en la raíz) para crear (o restablecer) la contraseña.
// Se guarda solo el SHA-256; generar uno nuevo invalida el anterior.

export const invitePath = (token) => `/#invite=${token}`;

export async function createInvite(env, userId) {
  const token = randomHex(32);
  await globalDb(env).run('UPDATE users SET invite_hash = ? WHERE id = ?', await sha256Hex(token), userId);
  return token;
}

export async function userByInvite(env, token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
  return globalDb(env).first('SELECT * FROM users WHERE invite_hash = ?', await sha256Hex(token));
}

// ---------- sesiones ----------

const isoIn = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');

export async function createSession(env, user, businessId) {
  const token = randomHex(32);
  await globalDb(env).run(
    'INSERT INTO sessions (id, user_id, email, business_id, expires_at) VALUES (?, ?, ?, ?, ?)',
    await sha256Hex(token), user.id, user.email, businessId, isoIn(SESSION_HOURS * 3600 * 1000),
  );
  return token;
}

export function sessionCookie(token, req) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  const maxAge = token ? SESSION_HOURS * 3600 : 0;
  return `${SESSION_COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// Carga sesión + usuario + rol en el negocio activo en una sola consulta.
export async function loadSession(req, env) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await globalDb(env).first(
    `SELECT s.id AS session_id, s.business_id,
            u.id AS user_id, u.email, u.name,
            m.role, b.name AS business_name, b.slug AS business_slug, b.logo_key AS business_logo_key, b.status AS business_status, b.timezone, b.paid_until
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.user_id = u.id AND m.business_id = s.business_id
       LEFT JOIN businesses b ON b.id = s.business_id
      WHERE s.id = ? AND s.expires_at > ?`,
    await sha256Hex(token), nowIso(),
  );
  if (!row) return null;
  row.read_only = isExpired(row.paid_until);
  return row;
}

export async function destroySession(env, sessionId) {
  await globalDb(env).run('DELETE FROM sessions WHERE id = ?', sessionId);
}

// ---------- suscripción ----------
// businesses.paid_until ('YYYY-MM-DD', inclusive) lo fija Diwilo Web. NULL = sin límite.
// Vencida -> solo lectura: toda escritura del negocio responde 402.

const todayBogota = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
export const isExpired = (paidUntil) => !!paidUntil && paidUntil < todayBogota();

function assertWritable(c, paidUntil) {
  if (c.req.method !== 'GET' && isExpired(paidUntil)) {
    throw new HttpError(402, 'La suscripción del negocio está vencida: solo lectura.', 'READ_ONLY');
  }
}

// ---------- niveles de autorización por ruta ----------
//   'public'   : sin sesión (login, invitaciones)
//   'session'  : sesión vigente (correo + contraseña)
//   'tenant'   : + negocio activo con membresía
//   'manager'  : + rol owner/admin en el negocio
//   'resident' : portal de propietarios: negocio del encabezado x-business + unidades vinculadas (tabla residents)
//   'platform' : Diwilo Web (RPC por service binding, ver platform-rpc.js)

// Diwilo Web entra solo por RPC (Platform.call, ver platform-rpc.js); desde internet /api/platform da 401.
async function authenticatePlatform(c) {
  if (!isPlatformCall(c.req)) throw new HttpError(401, 'No autorizado');
}

export async function authenticate(c, level) {
  if (level === 'public') return;
  if (level === 'platform') return authenticatePlatform(c);
  if (level === 'resident') return authenticateResident(c);
  const s = await loadSession(c.req, c.env);
  if (!s) throw new HttpError(401, 'Inicia sesión', 'NO_SESSION');
  c.session = s;
  c.user = { id: s.user_id, email: s.email, name: s.name };

  // El panel vive en /<slug>/admin y envía el negocio en x-business: manda sobre el de la sesión.
  // (en GET también por ?b=<slug>, para enlaces que se abren en otra pestaña, p. ej. archivos)
  const slug = c.req.headers.get('x-business') || (c.req.method === 'GET' && c.url?.searchParams.get('b')) || null;
  if (slug && slug !== s.business_slug) {
    const b = await globalDb(c.env).first(
      `SELECT b.id, b.name, b.slug, b.status, b.timezone, b.paid_until, b.logo_key, m.role
         FROM businesses b LEFT JOIN memberships m ON m.business_id = b.id AND m.user_id = ?
        WHERE b.slug = ?`,
      s.user_id, slug,
    );
    if (!b) throw new HttpError(404, 'Consultorio no encontrado', 'NO_BUSINESS');
    // Las rutas de solo sesión (/auth/*) también se llaman desde el portal, donde la persona no es miembro.
    if (!b.role && level === 'session') return;
    if (!b.role) throw new HttpError(403, 'No tienes acceso a este negocio', 'NOT_MEMBER');
    Object.assign(s, {
      business_id: b.id, business_name: b.name, business_slug: b.slug, business_logo_key: b.logo_key, business_status: b.status,
      timezone: b.timezone, paid_until: b.paid_until, role: b.role, read_only: isExpired(b.paid_until),
    });
  }

  if (level === 'session') return;
  if (!s.business_id || !s.role) throw new HttpError(409, 'Selecciona un negocio', 'NO_BUSINESS');
  if (s.business_status !== 'active') throw new HttpError(403, 'Negocio suspendido');
  assertWritable(c, s.paid_until);
  c.businessId = s.business_id;
  c.role = s.role;
  c.timezone = s.timezone || 'America/Bogota';
  if (level === 'manager' && !['owner', 'admin'].includes(s.role)) {
    throw new HttpError(403, 'Requiere rol de administrador del negocio');
  }
}

// ---------- portal de propietarios ----------
// Dos formas de entrar a /<slug>/portal:
//   1. apartamento + cédula del propietario -> cookie cdr_portal (tabla portal_sessions), sin usuario
//   2. usuario con correo y contraseña vinculado a unidades (tabla residents)

export const PORTAL_COOKIE = 'cdr_portal';
// Cédula comparable: solo letras y números ("1.020.304-5" = "10203045").
export const normalizeDoc = (v) => String(v || '').replace(/[^0-9a-z]/gi, '').toUpperCase();

export async function createPortalSession(env, businessId, unitId, doc) {
  const token = randomHex(32);
  await globalDb(env).run(
    'INSERT INTO portal_sessions (id, business_id, unit_id, doc_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
    await sha256Hex(token), businessId, unitId, await sha256Hex(normalizeDoc(doc)), isoIn(SESSION_HOURS * 3600 * 1000),
  );
  return token;
}

export function portalCookie(token, req) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${PORTAL_COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_HOURS * 3600 : 0}${secure}`;
}

// Sesión de cédula vigente (opcionalmente de un negocio).
export async function loadPortalSession(req, env, businessId = null) {
  const token = getCookie(req, PORTAL_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await globalDb(env).first(
    `SELECT ps.id AS session_id, ps.business_id, ps.unit_id, ps.doc_hash, u.owner_doc, u.owner_name
       FROM portal_sessions ps JOIN units u ON u.id = ps.unit_id
      WHERE ps.id = ? AND ps.expires_at > ?`,
    await sha256Hex(token), nowIso(),
  );
  if (!row || (businessId && row.business_id !== businessId)) return null;
  // La cédula de la unidad cambió desde el ingreso: la sesión ya no vale.
  if (!timingSafeEqualHex(row.doc_hash, await sha256Hex(normalizeDoc(row.owner_doc)))) return null;
  return row;
}

export async function destroyPortalSession(env, sessionId) {
  await globalDb(env).run('DELETE FROM portal_sessions WHERE id = ?', sessionId);
}

// Portal: el negocio sale de la ruta (/<slug>/portal -> x-business) y la persona solo ve sus unidades.
async function authenticateResident(c) {
  const slug = c.req.headers.get('x-business') || (c.req.method === 'GET' && c.url?.searchParams.get('b')) || null;
  if (!slug) throw new HttpError(409, 'Selecciona un conjunto', 'NO_BUSINESS');
  const db = globalDb(c.env);
  const b = await db.first('SELECT id, name, slug, status, timezone, paid_until, logo_key FROM businesses WHERE slug = ?', slug);
  if (!b || b.status !== 'active') throw new HttpError(404, 'Administración no encontrada', 'NO_BUSINESS');

  let units;
  const ps = await loadPortalSession(c.req, c.env, b.id);
  if (ps) {
    // Con cédula: la unidad del ingreso + las demás del negocio con la misma cédula del propietario.
    const doc = normalizeDoc(ps.owner_doc);
    if (!doc) throw new HttpError(401, 'La cédula de la unidad cambió. Ingresa de nuevo.', 'NO_SESSION');
    const all = await db.all(
      "SELECT id AS unit_id, property_id, owner_doc FROM units WHERE business_id = ? AND owner_doc IS NOT NULL AND owner_doc <> ''",
      b.id,
    );
    units = all.filter((u) => normalizeDoc(u.owner_doc) === doc).map(({ unit_id, property_id }) => ({ unit_id, property_id, relation: 'owner' }));
    if (!units.some((u) => u.unit_id === ps.unit_id)) throw new HttpError(401, 'La cédula de la unidad cambió. Ingresa de nuevo.', 'NO_SESSION');
    c.user = { id: null, email: null, name: ps.owner_name };
    c.portalSession = ps;
  } else {
    const s = await loadSession(c.req, c.env);
    if (!s) throw new HttpError(401, 'Ingresa con tu apartamento y cédula', 'NO_SESSION');
    c.session = s;
    c.user = { id: s.user_id, email: s.email, name: s.name };
    units = await db.all(
      `SELECT r.unit_id, r.relation, u.property_id FROM residents r JOIN units u ON u.id = r.unit_id
        WHERE r.user_id = ? AND r.business_id = ?`,
      c.user.id, b.id,
    );
    if (!units.length) throw new HttpError(403, 'Tu usuario no está vinculado a ninguna unidad de esta administración', 'NOT_RESIDENT');
  }
  assertWritable(c, b.paid_until);
  c.business = b;
  c.businessId = b.id;
  c.timezone = b.timezone || 'America/Bogota';
  c.role = 'resident';
  c.units = units;
}
