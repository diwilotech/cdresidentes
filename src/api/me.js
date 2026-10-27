// Lo que necesita el shell común (public/js/shell.js) para pintar la app: usuario, negocio, rol,
// módulos visibles (activos + permitidos para el rol), tema y estado de la suscripción.
import { json } from '../lib/http.js';
import { db } from '../lib/db.js';
import { userBusinesses, isExpired } from '../lib/auth.js';
import { APP, AMBITO, visibleModules } from '../lib/modules.js';

export const TEMAS = ['azul', 'indigo', 'violeta', 'rosa', 'rojo', 'naranja', 'verde', 'turquesa', 'grafito'];

export async function businessSettings(env, businessId) {
  // El logo es uno solo: el de la administración (businesses.logo_key), que también ven el portal, la cuenta de cobro y el ingreso
  const s = await db(env).first('SELECT s.tema, s.modo, COALESCE(b.logo_key, s.logo_key) AS logo_key, COALESCE(s.updated_at, b.updated_at) AS updated_at FROM businesses b LEFT JOIN business_settings s ON s.business_id = b.id WHERE b.id = ?', businessId);
  return { tema: TEMAS.includes(s?.tema) ? s.tema : APP.tema, modo: s?.modo === 'dark' ? 'dark' : 'light', logo: s?.logo_key ? `/api/settings/logo?v=${encodeURIComponent(s.updated_at)}` : null };
}

export function routes(r) {
  r.get('/api/me', 'tenant', async (c) => {
    const s = c.session;
    const mods = await visibleModules(c.env, c.businessId, c.role, c.modulos);
    return json({
      app: APP,
      ambito: AMBITO,
      user: { id: s.user_id, email: s.email, name: s.name },
      business: { id: c.businessId, name: s.business_name, slug: s.business_slug, paidUntil: s.paid_until, readOnly: isExpired(s.paid_until) },
      role: c.role,
      settings: await businessSettings(c.env, c.businessId),
      modules: mods.map((m) => ({ id: m.id, nombre: m.nombre, icono: m.icono, ruta: m.menu?.ruta, oculto: !!m.menu?.oculto, tipo: m.tipo, orden: m.menu?.orden ?? 99, widgets: m.widgets || [], configurar: m.permisos?.configurar || 'admin' })),
      businesses: (await userBusinesses(c.env, { id: s.user_id })).map((b) => ({ id: b.id, name: b.name })),
    });
  });
}
