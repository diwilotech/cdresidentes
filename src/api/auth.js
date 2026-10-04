import { json, readJson, HttpError, str } from '../lib/http.js';
import {
  userByEmail, loadSession, userBusinesses, checkPassword, setPassword, isWeakPassword,
  createSession, sessionCookie, destroySession, createInvite, userByInvite,
} from '../lib/auth.js';
import { globalDb } from '../lib/db.js';
import { brandUrl } from './files.js';

// Abre sesión y elige el negocio si solo tiene uno activo.
async function startSession(c, user) {
  const businesses = await userBusinesses(c.env, user);
  const businessId = businesses.length === 1 ? businesses[0].id : null;
  const token = await createSession(c.env, user, businessId);
  return json({ ok: true, businessId, businesses }, 200, { 'set-cookie': sessionCookie(token, c.req) });
}

export function routes(r) {
  // Estado de la sesión: lo usa login.html y el encabezado de cada página.
  r.get('/api/admin/auth/me', 'session', async (c) => {
    const s = c.session;
    return json({
      userId: c.user.id,
      email: c.user.email,
      name: c.user.name,
      session: {
        businessId: s.business_id, businessName: s.business_name, businessSlug: s.business_slug, businessLogo: brandUrl(s.business_logo_key), role: s.role,
        readOnly: s.read_only, paidUntil: s.paid_until || null,
      },
      businesses: await userBusinesses(c.env, c.user),
    });
  });

  r.post('/api/admin/auth/login', 'public', async (c) => {
    const { email, password } = await readJson(c.req);
    const user = await userByEmail(c.env, email);
    await checkPassword(c.env, user, password);
    // Credencial vieja (PIN): se acepta una vez y pide crear la contraseña.
    if (isWeakPassword(password)) {
      return json({ ok: true, mustSetPassword: true, invite: await createInvite(c.env, user.id) });
    }
    return startSession(c, user);
  });

  // Link de invitación: crear (o restablecer) la contraseña.
  r.get('/api/admin/auth/invite', 'public', async (c) => {
    const user = await userByInvite(c.env, c.url.searchParams.get('token'));
    if (!user) throw new HttpError(404, 'Este link ya no es válido. Pide uno nuevo.', 'BAD_INVITE');
    return json({ email: user.email, name: user.name, reset: !!user.pin_hash });
  });

  r.post('/api/admin/auth/invite', 'public', async (c) => {
    const body = await readJson(c.req);
    const user = await userByInvite(c.env, body.token);
    if (!user) throw new HttpError(404, 'Este link ya no es válido. Pide uno nuevo.', 'BAD_INVITE');
    await setPassword(c.env, user.id, body.password);
    const name = str(body.name, { max: 100, label: 'Nombre' });
    const db = globalDb(c.env);
    await db.batch([
      db.prepare('UPDATE users SET name = COALESCE(?, name) WHERE id = ?', name, user.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ?', user.id),
    ]);
    return startSession(c, user);
  });

  // Cambia el negocio activo de la sesión.
  r.post('/api/admin/auth/business', 'session', async (c) => {
    const { businessId } = await readJson(c.req);
    const allowed = await userBusinesses(c.env, c.user);
    const b = allowed.find((x) => x.id === businessId);
    if (!b) throw new HttpError(403, 'No perteneces a ese negocio');
    await globalDb(c.env).run('UPDATE sessions SET business_id = ? WHERE id = ?', b.id, c.session.session_id);
    return json({ ok: true, businessId: b.id, businessName: b.name });
  });

  r.post('/api/admin/auth/change-password', 'session', async (c) => {
    const { currentPassword, newPassword } = await readJson(c.req);
    const user = await userByEmail(c.env, c.user.email);
    await checkPassword(c.env, user, currentPassword);
    await setPassword(c.env, user.id, newPassword);
    return json({ ok: true });
  });

  r.post('/api/admin/auth/logout', 'session', async (c) => {
    await destroySession(c.env, c.session.session_id);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(null, c.req) });
  });
}
