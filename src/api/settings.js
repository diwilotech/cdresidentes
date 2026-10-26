// Configuración del negocio: Apariencia (tema, modo y logo) y Bitácora. Solo propietario y administrador cambian.
import { json, readJson, HttpError, oneOf } from '../lib/http.js';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { TEMAS, businessSettings } from './me.js';

const LOGO = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/;
const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', 'svg+xml': 'svg' };

export function routes(r) {
  r.get('/api/settings/apariencia', 'tenant', async (c) => json(await businessSettings(c.env, c.businessId)));

  r.put('/api/settings/apariencia', 'manager', async (c) => {
    const body = await readJson(c.req);
    const tema = oneOf(body.tema, TEMAS, { label: 'Tema' });
    const modo = oneOf(body.modo, ['light', 'dark'], { label: 'Modo' });
    if (!tema && !modo) throw new HttpError(400, 'Elige un tema o un modo');
    const cur = await businessSettings(c.env, c.businessId);
    await db(c.env).run(`INSERT INTO business_settings (business_id, tema, modo, updated_by, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(business_id) DO UPDATE SET tema = excluded.tema, modo = excluded.modo, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      c.businessId, tema || cur.tema, modo || cur.modo, c.session.user_id);
    await audit(c, 'Cambió la apariencia', { modulo: 'marca', detalle: { tema: tema || cur.tema, modo: modo || cur.modo } });
    return json(await businessSettings(c.env, c.businessId));
  });

  // Logo de la administración en R2: <business_id>/brand/<uuid> (businesses.logo_key; el mismo lo ven el portal, la cuenta de cobro y el ingreso)
  r.put('/api/settings/logo', 'manager', async (c) => {
    if (!c.env.FILES) throw new HttpError(501, 'Esta app no tiene almacenamiento de archivos (R2) configurado');
    const m = LOGO.exec(String((await readJson(c.req)).dataUrl || ''));
    if (!m) throw new HttpError(400, 'El logo debe ser una imagen PNG, JPG, WEBP o SVG');
    const bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    if (bytes.length > 300 * 1024) throw new HttpError(400, 'El logo pesa más de 300 KB');
    const prev = await db(c.env).first('SELECT logo_key FROM businesses WHERE id = ?', c.businessId);
    const key = `${c.businessId}/brand/${crypto.randomUUID()}`;
    await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });
    if (prev?.logo_key && prev.logo_key !== key) c.ctx.waitUntil(c.env.FILES.delete(prev.logo_key));
    await db(c.env).batch([
      db(c.env).prepare("UPDATE businesses SET logo_key = ?, updated_at = datetime('now') WHERE id = ?", key, c.businessId),
      db(c.env).prepare(`INSERT INTO business_settings (business_id, logo_key, updated_by) VALUES (?, ?, ?)
        ON CONFLICT(business_id) DO UPDATE SET logo_key = excluded.logo_key, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`, c.businessId, key, c.session.user_id),
    ]);
    await audit(c, 'Cambió el logo', { modulo: 'marca' });
    return json(await businessSettings(c.env, c.businessId));
  });

  r.delete('/api/settings/logo', 'manager', async (c) => {
    const prev = await db(c.env).first('SELECT logo_key FROM businesses WHERE id = ?', c.businessId);
    if (prev?.logo_key && c.env.FILES) c.ctx.waitUntil(c.env.FILES.delete(prev.logo_key));
    await db(c.env).batch([
      db(c.env).prepare("UPDATE businesses SET logo_key = NULL, updated_at = datetime('now') WHERE id = ?", c.businessId),
      db(c.env).prepare(`UPDATE business_settings SET logo_key = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE business_id = ?`, c.businessId),
    ]);
    await audit(c, 'Quitó el logo', { modulo: 'marca' });
    return json(await businessSettings(c.env, c.businessId));
  });

  r.get('/api/settings/logo', 'tenant', async (c) => {
    const s = await db(c.env).first('SELECT logo_key FROM businesses WHERE id = ?', c.businessId);
    const obj = s?.logo_key && c.env.FILES ? await c.env.FILES.get(s.logo_key) : null;
    if (!obj) throw new HttpError(404, 'Sin logo');
    return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
  });

  // Bitácora del negocio (últimos 200 movimientos).
  r.get('/api/settings/bitacora', 'manager', async (c) => json({
    items: await db(c.env).all(`SELECT a.created_at, a.origen, a.modulo, a.accion, a.detalle, u.email
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.business_id = ? ORDER BY a.id DESC LIMIT 200`, c.businessId),
  }));
}
