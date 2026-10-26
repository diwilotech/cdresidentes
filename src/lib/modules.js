// Módulos de la app y cuáles están activos para cada negocio.
//   - modulos.app.json → "modulos": los propios de esta app (su código está en src/api/).
//   - modulos.app.json → "centrales": los horizontales que usa del Worker central «Diwilo Modulos» (Finanzas, Marketing…):
//     sus datos, su lógica y el código de sus páginas viven allá; la app los llama por RPC (src/lib/central.js).
//   - business_modules: copia local de los módulos efectivos que asigna Diwilo (plan + excepciones).
//     Un negocio que Diwilo aún no gestiona (sin fila en business_modules_sync) tiene todos los módulos activos.
// Los módulos base (dashboard=Inicio, equipo) siempre están activos y no se listan aquí. «ai» (IA: chats, agentes, conexiones, API, consumo y bitácora) y «marca»
// (la marca del negocio: logo, color, tono) son módulos centrales BASE, siempre activos sin depender del plan.
import appManifest from '../../modulos.app.json';
import { HttpError } from './http.js';
import { todayBogota } from './auth.js';

export const APP = { id: appManifest.app, nombre: appManifest.nombre, tema: appManifest.tema || 'violeta' };
// Apps con varias sedes (conjuntos, edificios, sucursales): el shell pinta su selector y el Inicio muestra el portafolio.
export const AMBITO = appManifest.ambito || null;
export const CENTRALES = appManifest.centrales || [];
export const BASE_CENTRALES = CENTRALES.filter((id) => ['marca', 'ai', 'dashboard'].includes(id));
const OWN = (appManifest.modulos || []).map((m) => ({ ...m, tipo: 'propio' }));
export const OWN_IDS = OWN.map((m) => m.id);
const byOrder = (a, b) => (a.menu?.orden ?? 99) - (b.menu?.orden ?? 99);

// Manifiestos de los módulos centrales: se piden al Worker central y se recuerdan 5 minutos.
let central = null, centralAt = 0;
async function centralModules(env) {
  if (!CENTRALES.length) return [];
  if (central && Date.now() - centralAt < 300000) return central;
  try {
    const cat = await env.MODULOS.catalog();
    central = CENTRALES.map((id) => cat.find((m) => m.id === id)).filter(Boolean).map((m) => ({ ...m, tipo: 'compartido', central: true }));
    centralAt = Date.now();
  } catch (e) {
    console.error('módulos centrales', e.message);
    // Sin el Worker central: el menú los sigue mostrando (su API responderá con error) para no perder la configuración.
    central ||= CENTRALES.map((id) => ({ id, nombre: id.charAt(0).toUpperCase() + id.slice(1), tipo: 'compartido', central: true, permisos: { ver: 'admin' }, menu: { ruta: `/staff/${id}.html`, orden: 90 } }));
  }
  return central;
}

// Catálogo completo de la app (propios + centrales), ordenado como el menú.
export const allModules = async (env) => [...OWN, ...(await centralModules(env))].sort(byOrder);
export const moduleById = async (env, id) => (await allModules(env)).find((m) => m.id === id);

const RANK = { staff: 1, admin: 2, owner: 3 };
export const roleReaches = (role, min = 'staff') => (RANK[role] || 0) >= (RANK[min] || 1);

// Ids de los módulos activos hoy para el negocio.
export async function activeModuleIds(env, businessId) {
  const all = await allModules(env);
  const rows = (await env.DB.prepare('SELECT modulo, activo, desde, hasta FROM business_modules WHERE business_id = ?').bind(businessId).all()).results;
  // Sin filas y sin gestión de Diwilo (negocios de antes): todos activos. Gestionado por Diwilo: la lista es exacta.
  if (!rows.length && !(await env.DB.prepare('SELECT 1 FROM business_modules_sync WHERE business_id = ?').bind(businessId).first())) return all.map((m) => m.id);
  const today = todayBogota();
  const on = new Set(rows.filter((r) => r.activo && (!r.desde || r.desde <= today) && (!r.hasta || r.hasta >= today)).map((r) => r.modulo));
  return all.filter((m) => on.has(m.id) || BASE_CENTRALES.includes(m.id)).map((m) => m.id);
}

// Lo que el personal NO ve mientras no se le asigne (propietario y administradores ven todo).
export const STAFF_SIN_ACCESO = ['finanzas', 'marketing', 'nomina'];
export const parseModulos = (raw) => { try { const a = JSON.parse(raw); return Array.isArray(a) ? a : null; } catch { return null; } };
// ¿Esta persona puede abrir el módulo? `modulos` = lista elegida para ella (null = la de su rol).
export const moduleAllowed = (role, modulos, id) => role !== 'staff' || BASE_CENTRALES.includes(id) || (modulos ? modulos.includes(id) : !STAFF_SIN_ACCESO.includes(id));
// Módulos que se le pueden dar o quitar al personal (los que el personal puede ver por su rol).
export async function assignableModules(env) {
  return (await allModules(env)).filter((m) => (m.permisos?.ver || 'staff') === 'staff' && !BASE_CENTRALES.includes(m.id));
}

// Módulos que ve un usuario: activos para el negocio, permitidos para su rol y asignados a él.
export async function visibleModules(env, businessId, role, modulos = null) {
  const active = new Set(await activeModuleIds(env, businessId));
  return (await allModules(env)).filter((m) => active.has(m.id) && roleReaches(role, m.permisos?.ver || 'staff') && moduleAllowed(role, modulos, m.id));
}

// Lo llama authenticate() en cada ruta que declara su módulo ('tenant:items'): inactivo o sin permiso = 403.
export async function requireModule(c, moduleId) {
  const m = await moduleById(c.env, moduleId);
  if (!m) throw new HttpError(500, `Módulo desconocido: ${moduleId}`);
  if (!(await activeModuleIds(c.env, c.businessId)).includes(moduleId)) {
    throw new HttpError(403, `El módulo ${m.nombre} no está activo para este negocio`, 'MODULE_OFF');
  }
  if (!roleReaches(c.role, m.permisos?.ver || 'staff') || !moduleAllowed(c.role, c.modulos, moduleId)) throw new HttpError(403, `Tu rol no tiene acceso a ${m.nombre}`);
  c.module = m;
}
