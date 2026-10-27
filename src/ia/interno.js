// Despachador interno para las herramientas de IA: ejecuta las MISMAS rutas de la API (src/api/*.js) dentro del Worker,
// con el contexto del token del MCP. Así cada herramienta hereda validaciones, permisos por rol/módulo, bitácora y reglas de negocio
// sin duplicar lógica. Solo entran rutas del equipo (tenant | manager | any); nunca las del estudiante, de plataforma o públicas.
import { Router } from '../router.js';
import { HttpError } from '../lib/http.js';
import { requireModule } from '../lib/modules.js';
import * as propertiesApi from '../api/properties.js';
import * as unitsApi from '../api/units.js';
import * as chargesApi from '../api/charges.js';
import * as billingApi from '../api/billing.js';
import * as requestsApi from '../api/requests.js';
import * as pqrsApi from '../api/pqrs.js';
import * as bookingsApi from '../api/bookings.js';
import * as petsApi from '../api/pets.js';
import * as noticesApi from '../api/notices.js';
import * as businessApi from '../api/business.js';
import * as settingsApi from '../api/settings.js';

let router;
const rutas = () => {
  if (!router) {
    router = new Router();
    for (const m of [propertiesApi, unitsApi, chargesApi, billingApi, requestsApi, pqrsApi, bookingsApi, petsApi, noticesApi, businessApi, settingsApi]) m.routes?.(router);
  }
  return router;
};

// Listas muy largas se recortan para no llenar el contexto del asistente.
export function recortar(v, max = 150) {
  if (Array.isArray(v)) return v.length > max ? [...v.slice(0, max).map((x) => recortar(x, max)), { aviso: `Hay ${v.length - max} más; acota con filtros` }] : v.map((x) => recortar(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, recortar(x, max)]));
  return v;
}

export async function llamar(c, metodo, ruta, { query, body } = {}) {
  const url = new URL(ruta, c.url.origin);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  const { route, params } = rutas().match(metodo, url.pathname);
  const [nivel, modulo] = String(route.auth).split(':');
  if (!['tenant', 'manager', 'any'].includes(nivel)) throw new HttpError(403, 'Esa acción no está disponible por la IA');
  if (nivel === 'manager' && !['owner', 'admin'].includes(c.role)) throw new HttpError(403, 'Solo el propietario o un administrador');
  if (metodo !== 'GET' && c.readOnly) throw new HttpError(402, 'La suscripción del negocio está vencida: solo lectura.');
  const req = new Request(url, { method: metodo, headers: { 'content-type': 'application/json' }, body: metodo === 'GET' || body === undefined ? undefined : JSON.stringify(body) });
  const h = { ...c, req, url, params };
  if (modulo) await requireModule(h, modulo);
  const res = await route.handler(h);
  if (h.audited) c.audited = true;
  if (!(res.headers.get('content-type') || '').includes('json')) throw new HttpError(415, 'Esa respuesta es un archivo o página: se ve desde la app');
  const data = await res.json();
  if (res.status >= 400) throw new HttpError(res.status, data?.error || 'No se pudo completar');
  return recortar(data);
}

// Define una herramienta que llama a una ruta de la API. Los parámetros :x de la ruta salen de los argumentos;
// el resto va como consulta (GET) o como cuerpo JSON (POST, PUT, PATCH, DELETE).
export function herramienta({ name, modulo, rol = 'staff', tipo, description, props = {}, required = [], ruta: [metodo, patron], salida }) {
  return {
    name, modulo, rol, tipo, description,
    inputSchema: { type: 'object', properties: props, required, additionalProperties: false },
    run: async (c, a) => {
      const resto = { ...a };
      const ruta = patron.replace(/:(\w+)/g, (_, k) => { const v = resto[k]; delete resto[k]; if (v === undefined || v === null || v === '') throw new HttpError(400, `Falta ${k}`); return encodeURIComponent(v); });
      const out = await llamar(c, metodo, ruta, metodo === 'GET' ? { query: resto } : { body: resto });
      return salida ? salida(out, a) : out;
    },
  };
}

// Listar / crear / editar / borrar de una entidad con el CRUD genérico (/api/<base>/<entidad>).
// Nombres: <modulo>.listar_<plural>, crear_<singular>, editar_<singular>, borrar_<singular>.
// `filtros`: filtros extra del listado (f_<campo>); `escribe`/`borra`: nivel mínimo de rol; `sin`: acciones que no se publican.
export function crudHerramientas({ modulo, base, entidad, singular, plural, props, required = [], filtros = {}, escribe = 'staff', borra = 'admin', sin = [] }) {
  const ruta = `/api/${base}/${entidad}`, art = `${singular}`;
  const todas = {
    listar: () => herramienta({ name: `${modulo}.listar_${plural}`, modulo, tipo: 'lectura', description: `Lista ${plural} (busca por texto y filtra) con todos sus datos.`,
      props: { q: { type: 'string', description: 'Texto a buscar' }, limit: { type: 'integer', description: 'Máximo de filas (por defecto 500)' }, ...Object.fromEntries(Object.entries(filtros).map(([k, d]) => [`f_${k}`, { type: 'string', description: d }])) },
      ruta: ['GET', ruta], salida: (o) => ({ [plural]: o.rows ?? o }) }),
    crear: () => herramienta({ name: `${modulo}.crear_${singular}`, modulo, rol: escribe, tipo: 'escritura', description: `Crea ${art}.`, props, required, ruta: ['POST', ruta] }),
    editar: () => herramienta({ name: `${modulo}.editar_${singular}`, modulo, rol: escribe, tipo: 'escritura', description: `Edita ${art}: solo cambian los campos que envíes.`, props: { id: { type: 'integer' }, ...props }, required: ['id'], ruta: ['PATCH', `${ruta}/:id`] }),
    borrar: () => herramienta({ name: `${modulo}.borrar_${singular}`, modulo, rol: borra, tipo: 'escritura', description: `Borra ${art} (no se puede deshacer; si tiene datos asociados la app lo rechaza).`, props: { id: { type: 'integer' } }, required: ['id'], ruta: ['DELETE', `${ruta}/:id`] }),
  };
  return Object.entries(todas).filter(([k]) => !sin.includes(k)).map(([, f]) => f());
}
