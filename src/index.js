// CD Residentes — Worker único: API + archivos de public/.
//   /            login (o al panel de su administración si ya hay sesión)
//   /<dirección> panel de la administración (ej. /altos-de-la-colina): una sola dirección fija; cada módulo se carga dentro (marco) sin cambiar la URL
//   /staff/*     páginas de cada módulo (las carga el panel; exigen sesión con negocio). Abiertas directo llevan al panel.
//   /<dirección>/portal/…  portal de propietarios y residentes (cédula o correo)
//   /api/*       API (src/api/*.js); /api/platform/* solo para Diwilo Web por RPC
//   /mcp         MCP de la administración (token de IA → Conexiones)
import { WorkerEntrypoint } from 'cloudflare:workers';
import { platformCall } from './lib/platform-rpc.js';
import { Router } from './router.js';
import { HttpError, errorResponse, json } from './lib/http.js';
import { authenticate, loadSession, loadPortalSession } from './lib/auth.js';
import { slugFromPath, businessBySlug, isMember, isResident, homePath, RESERVED } from './lib/tenant.js';
import * as authApi from './api/auth.js';
import * as platformApi from './api/platform.js';
import * as platformModulesApi from './api/platform-modules.js';
import * as meApi from './api/me.js';
import * as settingsApi from './api/settings.js';
import * as mcpApi from './api/mcp.js';
import * as businessApi from './api/business.js';
import * as dashboardApi from './api/dashboard.js';
import * as propertiesApi from './api/properties.js';
import * as unitsApi from './api/units.js';
import * as chargesApi from './api/charges.js';
import * as billingApi from './api/billing.js';
import * as requestsApi from './api/requests.js';
import * as pqrsApi from './api/pqrs.js';
import * as bookingsApi from './api/bookings.js';
import * as petsApi from './api/pets.js';
import * as noticesApi from './api/notices.js';
import * as filesApi from './api/files.js';
import * as aiApi from './api/ai.js';
import * as portalApi from './api/portal.js';
import { isCentralApi, centralModuleOf, centralApi, centralPage, centralAsset, centralPublic } from './lib/central.js';
import { CENTRALES } from './lib/modules.js';

const router = new Router();
// platform va primero. Agrega aquí cada módulo nuevo de src/api/ (y su entrada en modulos.app.json).
// Los horizontales (Inicio, Marca, IA, Finanzas, Marketing, Nómina) no van aquí: se piden en modulos.app.json → "centrales" y viven en Diwilo Modulos.
const MODULE_APIS = [businessApi, dashboardApi, propertiesApi, unitsApi, billingApi, chargesApi, requestsApi, pqrsApi, bookingsApi, petsApi, noticesApi, filesApi, aiApi, portalApi];
for (const mod of [platformApi, platformModulesApi, authApi, meApi, settingsApi, mcpApi, ...MODULE_APIS]) if (typeof mod.routes === 'function') mod.routes(router);

const SECURITY_HEADERS = {
  'x-frame-options': 'SAMEORIGIN',   // el panel carga las páginas de los módulos en un marco del mismo sitio
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

async function handleApi(req, env, ctx, url) {
  const { route, params } = router.match(req.method, url.pathname);
  // CSRF: toda escritura del navegador trae este encabezado (fuerza preflight entre orígenes).
  // Diwilo Web (nivel 'platform') llega por RPC y no usa cookies.
  if (req.method !== 'GET' && route.auth !== 'platform' && req.headers.get('x-cdr') !== '1' && req.headers.get('x-app') !== '1') {
    throw new HttpError(403, 'Solicitud no permitida');
  }
  const c = { req, env, ctx, url, params };
  await authenticate(c, route.auth);
  return route.handler(c);
}

// Módulos centrales: la app verifica sesión, negocio, rol, módulo activo y CSRF; Diwilo Modulos hace el resto.
async function handleCentral(req, env, ctx, url) {
  if (req.method !== 'GET' && req.headers.get('x-app') !== '1') throw new HttpError(403, 'Solicitud no permitida');
  const c = { req, env, ctx, url, params: {} };
  await authenticate(c, `tenant:${centralModuleOf(url.pathname)}`);
  // Guía de uso del módulo para el MCP (se arma aquí con su manifiesto y las herramientas del rol)
  if (req.method === 'GET' && /^\/api\/[a-z]+\/mcp$/.test(url.pathname)) return json(await mcpApi.guiaDeModulo(c, centralModuleOf(url.pathname), url.origin));
  return centralApi(c);
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,48}$/;
const aPanel = (url, slug, go) => Response.redirect(`${url.origin}/${slug}${go ? `?go=${encodeURIComponent(go)}` : ''}`, 302);
// Páginas viejas del panel (/admin/<sección>) → página del módulo
const PAGINA = { '': '/staff/', conjuntos: '/staff/conjuntos.html', unidades: '/staff/unidades.html', cartera: '/staff/cartera.html', solicitudes: '/staff/porteria.html', pqrs: '/staff/pqrs.html', reservas: '/staff/porteria.html?tab=reservas',
  mascotas: '/staff/mascotas.html', comunicados: '/staff/porteria.html?tab=comunicados', asistente: '/staff/ai.html', ajustes: '/staff/ajustes.html' };

const assetAt = (env, req, path) => {
  const u = new URL(req.url);
  u.pathname = path;
  return env.ASSETS.fetch(new Request(u, req));
};

// Portal: conserva el prefijo /<slug> en las redirecciones de los assets (/portal -> /portal/).
function keepPrefix(res, prefix, url) {
  const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
  if (!loc) return res;
  const l = new URL(loc, url);
  return Response.redirect(`${url.origin}${prefix}${l.pathname}${l.search}`, 302);
}

const notFound = (msg) => new HttpError(404, msg || 'Esta página no existe.');

// /<slug>, /<slug>/admin/… (viejo) y /<slug>/portal/…
async function handleBusinessPath(req, env, url, slug) {
  const rest = url.pathname.slice(slug.length + 1) || '/';
  const business = await businessBySlug(env, slug);
  if (!business) {
    // Dirección anterior (la administración cambió de enlace): redirige a la actual conservando el resto.
    const alias = await env.DB.prepare('SELECT b.slug FROM business_slug_aliases a JOIN businesses b ON b.id = a.business_id WHERE a.slug = ?').bind(slug).first();
    if (alias) return Response.redirect(`${url.origin}/${alias.slug}${rest === '/' ? '' : rest}${url.search}`, 301);
  }
  if (!business || business.status !== 'active') throw notFound('No encontramos esta administración.');

  // Panel: sesión de la administración → panel; propietarios y residentes → su portal; sin sesión → ingreso.
  if (rest === '/') {
    const s = await loadSession(req, env);
    if (!s) return withHeaders(await assetAt(env, req, '/'), SECURITY_HEADERS);
    if (!(await isMember(env, s.user_id, slug))) {
      if (await isResident(env, s.user_id, slug)) return Response.redirect(`${url.origin}/${slug}/portal/`, 302);
      throw new HttpError(403, 'No tienes acceso a esta administración.');
    }
    // El panel va con la administración de la dirección: si la sesión estaba en otra, se cambia (es miembro de ambas)
    if (s.business_slug !== slug) {
      await env.DB.prepare('UPDATE sessions SET business_id = ? WHERE id = ?').bind(business.id, s.session_id).run();
    }
    return withHeaders(await assetAt(env, req, '/staff/panel'), { ...SECURITY_HEADERS, 'cache-control': 'no-store' });
  }
  // Direcciones viejas del panel: /<slug>/admin/<sección> → el panel con esa página dentro
  if (rest === '/admin' || rest.startsWith('/admin/')) {
    const sec = rest.replace(/^\/admin\/?/, '').replace(/\.html$/, '').replace(/\/$/, '');
    return aPanel(url, slug, PAGINA[sec] ? `${PAGINA[sec]}${url.search}` : null);
  }
  // Portal de propietarios: /<slug>/portal/… (los datos los filtra la API por las unidades de la persona).
  // Sin sesión se entra por /<slug>/portal/login (apartamento + cédula).
  if (rest === '/portal' || rest.startsWith('/portal/')) {
    const page = rest.replace(/\.html$/, '').replace(/\/$/, '');
    if (page !== '/portal/login' && !(await loadPortalSession(req, env, business.id)) && !(await loadSession(req, env))) {
      return Response.redirect(`${url.origin}/${slug}/portal/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    return keepPrefix(await assetAt(env, req, rest), `/${slug}`, url);
  }
  throw notFound();
}

const worker = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const isApi = url.pathname.startsWith('/api/');
    try {
      if (isApi && isCentralApi(url.pathname)) return withHeaders(await handleCentral(req, env, ctx, url), SECURITY_HEADERS);
      if (isApi) return withHeaders(await handleApi(req, env, ctx, url), SECURITY_HEADERS);
      if (url.pathname === '/mcp') return withHeaders(await mcpApi.mcpFetch(req, env, ctx), SECURITY_HEADERS);
      // Los chats de clientes se muestran dentro de las webs y tarjetas (iframe): su respuesta trae sus propios encabezados de marco
      if (url.pathname.startsWith('/chat/') || url.pathname.startsWith('/v1/')) return withHeaders(await centralPublic(env, url, req), { 'x-content-type-options': 'nosniff' });
      if (url.pathname.startsWith('/l/') || url.pathname.startsWith('/validar/') || url.pathname.startsWith('/c/')) return withHeaders(await centralPublic(env, url, req), SECURITY_HEADERS);
      // Código de las páginas de los módulos centrales
      if (url.pathname.startsWith('/m/')) return withHeaders(await centralAsset(env, url.pathname), SECURITY_HEADERS);

      // Raíz: login genérico (sin administración en la URL). Con sesión, directo a su panel o a su portal.
      if (url.pathname === '/') {
        const session = await loadSession(req, env);
        if (session) {
          const home = await homePath(env, session);
          if (home) return Response.redirect(`${url.origin}${home}`, 302);
        }
        return withHeaders(await assetAt(env, req, '/'), SECURITY_HEADERS);
      }

      // Direcciones viejas sin administración: /admin/… → al panel de la persona
      if (url.pathname === '/admin' || (url.pathname.startsWith('/admin/') && !url.pathname.startsWith('/admin/assets/'))) {
        const session = await loadSession(req, env);
        const home = session && (await homePath(env, session));
        const sec = url.pathname.replace(/^\/admin\/?/, '').replace(/\.html$/, '').replace(/\/$/, '');
        if (home && session.business_slug) return aPanel(url, home.slice(1), PAGINA[sec] || null);
        return Response.redirect(`${url.origin}${home || '/'}`, 302);
      }
      // /portal sin administración: al de la persona (o al login).
      if (url.pathname === '/portal' || url.pathname.startsWith('/portal/')) {
        const session = await loadSession(req, env);
        const home = session && (await homePath(env, session));
        return Response.redirect(`${url.origin}${home || '/'}`, 302);
      }

      // Páginas de los módulos (/staff/…): las carga el panel dentro de un marco; abiertas directo llevan al panel.
      if (url.pathname === '/staff' || url.pathname.startsWith('/staff/')) {
        const s = await loadSession(req, env);
        if (!s?.business_id || !s.role) return Response.redirect(`${url.origin}/`, 302);
        if (req.method === 'GET' && req.headers.get('sec-fetch-dest') === 'document' && !url.pathname.startsWith('/staff/panel') && (/^\/staff\/?$/.test(url.pathname) || url.pathname.endsWith('.html') || !/\.[a-z0-9]+$/i.test(url.pathname))) {
          return aPanel(url, s.business_slug, url.pathname + url.search);
        }
        const central = CENTRALES.find((id) => url.pathname === `/staff/${id}.html` || url.pathname === `/staff/${id}`);
        if (central) return withHeaders(await centralPage(env, req, central), SECURITY_HEADERS);
        return withHeaders(await env.ASSETS.fetch(req), { ...SECURITY_HEADERS, 'cache-control': 'no-store' });
      }

      // /<dirección de la administración>[/…]
      const slug = slugFromPath(url.pathname);
      if (slug && SLUG.test(slug) && !RESERVED.has(slug)) return withHeaders(await handleBusinessPath(req, env, url, slug), SECURITY_HEADERS);
      return env.ASSETS.fetch(req);
    } catch (err) {
      if (isApi) return errorResponse(err);
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      const msg = err instanceof HttpError ? err.message : 'Error interno';
      return new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>Acceso</title><body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">` +
          `<h1 style="font-size:1.25rem">${status === 404 ? 'Página no encontrada' : 'No se pudo abrir la página'}</h1><p>${msg.replace(/[<>&]/g, '')}</p></body>`,
        { status, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } },
      );
    }
  },
};

// Tareas diarias de los módulos propios (cron de wrangler.jsonc, 3:00 a. m. Colombia): cada módulo puede exportar daily(env).
// Las de los módulos centrales corren una sola vez en Diwilo Modulos.
worker.scheduled = async (event, env, ctx) => {
  for (const mod of MODULE_APIS) {
    if (typeof mod.daily !== 'function') continue;
    ctx.waitUntil(mod.daily(env).catch((e) => console.error('tarea diaria', e.message)));
  }
};

export default worker;

// Diwilo Web administra esta app por RPC (service binding con entrypoint "Platform"), sin clave compartida.
export class Platform extends WorkerEntrypoint {
  call(method, path, body, origin) {
    return platformCall(worker, this.env, this.ctx, method, path, body, origin);
  }
}
