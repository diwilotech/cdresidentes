// Módulos por negocio desde Diwilo Web (nivel 'platform': solo por RPC, desde internet 401).
// Archivo aparte de platform.js para no tocar el contrato. Diwilo calcula los módulos efectivos
// (plan + excepciones) y se los envía a la app; la app nunca se activa módulos a sí misma.
//   GET /api/platform/modules                  -> { app, nombre, modulos: [manifiestos] }  catálogo de la app
//   GET /api/platform/modules/sync             -> { rows: [{ business_id, version, synced_at }] }  huellas de todos los negocios
//   GET /api/platform/businesses/:id/modules   -> { modules, version, managed, uso: { modulo: registros } }
//   PUT /api/platform/businesses/:id/modules   { modules: [{ modulo, activo, desde?, hasta? }], version? }
//       Con `version` (la huella que calcula Diwilo) el negocio queda gestionado: la lista es exacta (vacía = ninguno).
//       Sin `version` vuelve al modo de antes (sin filas = todos activos).
import { json, readJson, HttpError, date } from '../lib/http.js';
import { db } from '../lib/db.js';
import { APP, allModules } from '../lib/modules.js';
import { centralUso } from '../lib/central.js';

const TABLA = /^[a-z][a-z0-9_]{1,40}$/;

// Registros de cada módulo en el negocio (suma de sus tablas): Diwilo avisa antes de quitar un módulo con datos.
async function usoDe(env, businessId) {
  const uso = await centralUso(env, businessId); // los centrales los cuenta Diwilo Modulos
  for (const m of (await allModules(env)).filter((x) => !x.central)) {
    let n = 0;
    for (const t of (m.tablas || []).filter((x) => TABLA.test(x))) {
      n += (await env.DB.prepare(`SELECT COUNT(*) n FROM ${t} WHERE business_id = ?`).bind(businessId).first().catch(() => ({ n: 0 }))).n;
    }
    uso[m.id] = n;
  }
  return uso;
}

export function routes(r) {
  r.get('/api/platform/modules', 'platform', async (c) => json({ app: APP.id, nombre: APP.nombre,
    modulos: (await allModules(c.env)).map(({ id, nombre, version, icono, descripcion, tipo, depende_de, permisos, menu }) => ({ id, nombre, version: version || null, icono, descripcion: descripcion || null, tipo, depende_de: depende_de || [], permisos, orden: menu?.orden ?? 99 })) }));

  r.get('/api/platform/modules/sync', 'platform', async (c) => json({ rows: await db(c.env).all('SELECT business_id, version, synced_at FROM business_modules_sync') }));

  r.get('/api/platform/businesses/:id/modules', 'platform', async (c) => {
    const rows = await db(c.env).all('SELECT modulo, activo, desde, hasta, synced_at FROM business_modules WHERE business_id = ? ORDER BY modulo', c.params.id);
    const sync = await db(c.env).first('SELECT version, synced_at FROM business_modules_sync WHERE business_id = ?', c.params.id);
    return json({ modules: rows, managed: !!sync, version: sync?.version || null, default: !sync && !rows.length, uso: await usoDe(c.env, c.params.id) });
  });

  r.put('/api/platform/businesses/:id/modules', 'platform', async (c) => {
    if (!(await db(c.env).first('SELECT 1 FROM businesses WHERE id = ?', c.params.id))) throw new HttpError(404, 'Negocio no encontrado');
    const b = await readJson(c.req), list = b.modules;
    if (!Array.isArray(list)) throw new HttpError(400, 'modules debe ser una lista');
    const version = b.version == null ? null : String(b.version).slice(0, 64);
    const mods = await allModules(c.env), moduleById = (id) => mods.find((x) => x.id === id);
    const rows = list.map((m) => {
      if (!moduleById(m.modulo)) throw new HttpError(400, `Módulo desconocido: ${m.modulo}`);
      return { modulo: m.modulo, activo: m.activo === false ? 0 : 1, desde: date(m.desde, { label: 'Desde' }) ?? null, hasta: date(m.hasta, { label: 'Hasta' }) ?? null };
    });
    // Dependencias: no se activa un módulo si falta lo que necesita.
    const on = new Set(rows.filter((x) => x.activo).map((x) => x.modulo));
    for (const id of on) for (const dep of moduleById(id).depende_de || []) if (!on.has(dep)) throw new HttpError(409, `${moduleById(id).nombre} necesita el módulo ${moduleById(dep)?.nombre || dep}`);
    const d = db(c.env);
    await d.batch([
      d.prepare('DELETE FROM business_modules WHERE business_id = ?', c.params.id),
      ...rows.map((x) => d.prepare('INSERT INTO business_modules (business_id, modulo, activo, desde, hasta) VALUES (?, ?, ?, ?, ?)', c.params.id, x.modulo, x.activo, x.desde, x.hasta)),
      version
        ? d.prepare("INSERT INTO business_modules_sync (business_id, version, synced_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(business_id) DO UPDATE SET version = excluded.version, synced_at = excluded.synced_at", c.params.id, version)
        : d.prepare('DELETE FROM business_modules_sync WHERE business_id = ?', c.params.id),
      d.prepare(`INSERT INTO audit_log (business_id, origen, modulo, accion, detalle) VALUES (?, 'diwilo', 'modulos', 'Diwilo actualizó los módulos', ?)`, c.params.id, JSON.stringify(rows)),
    ]);
    return json({ ok: true, modules: rows, version });
  });
}
