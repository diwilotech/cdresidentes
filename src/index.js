// CD Residentes — Worker monolítico: API + panel admin (HTML estáticos).
import { Router } from './router.js';
import { HttpError, errorResponse } from './lib/http.js';
import { authenticate, loadSession } from './lib/auth.js';
import { slugFromPath, businessBySlug, defaultSlug, isMember } from './lib/tenant.js';
import * as authApi from './api/auth.js';
import * as platformApi from './api/platform.js';
import * as businessApi from './api/business.js';
import * as dashboardApi from './api/dashboard.js';
import * as propertiesApi from './api/properties.js';
import * as unitsApi from './api/units.js';
import * as chargesApi from './api/charges.js';
import * as requestsApi from './api/requests.js';
import * as pqrsApi from './api/pqrs.js';
import * as bookingsApi from './api/bookings.js';
import * as petsApi from './api/pets.js';
import * as noticesApi from './api/notices.js';
import * as filesApi from './api/files.js';
import * as aiApi from './api/ai.js';

const router = new Router();
// platform va antes que cualquier ruta con parámetros de negocio.
for (const mod of [platformApi, authApi, businessApi, dashboardApi, propertiesApi, unitsApi, chargesApi, requestsApi, pqrsApi, bookingsApi, petsApi, noticesApi, filesApi, aiApi]) {
  mod.routes(router);
}

const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

async function handleApi(req, env, ctx, url) {
  const { route, params } = router.match(req.method, url.pathname);
  // Protección CSRF: toda mutación debe traer este encabezado (fuerza preflight entre orígenes).
  // Diwilo Web (nivel 'platform') no usa cookies: se autentica con PLATFORM_KEY.
  if (req.method !== 'GET' && route.auth !== 'platform' && req.headers.get('x-cdr') !== '1') {
    throw new HttpError(403, 'Solicitud no permitida');
  }
  const c = { req, env, ctx, url, params };
  await authenticate(c, route.auth);
  return route.handler(c);
}

const assetAt = (env, req, path) => {
  const u = new URL(req.url);
  u.pathname = path;
  return env.ASSETS.fetch(new Request(u, req));
};

// Las redirecciones de los assets (p. ej. /admin -> /admin/) deben conservar el prefijo /<slug>.
function keepPrefix(res, prefix, url) {
  const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
  if (!loc) return res;
  const l = new URL(loc, url);
  return Response.redirect(`${url.origin}${prefix}${l.pathname}${l.search}`, 302);
}

const notFound = (msg) => new HttpError(404, msg || 'Esta página no existe.');

// /<slug> y /<slug>/admin/…
async function handleBusinessPath(req, env, url, slug) {
  const rest = url.pathname.slice(slug.length + 1) || '/';
  const business = await businessBySlug(env, slug);
  if (!business) {
    // Dirección anterior (la administración cambió de enlace): redirige a la actual conservando el resto.
    const alias = await env.DB.prepare(
      'SELECT b.slug FROM business_slug_aliases a JOIN businesses b ON b.id = a.business_id WHERE a.slug = ?',
    ).bind(slug).first();
    if (alias) return Response.redirect(`${url.origin}/${alias.slug}${rest === '/' ? '' : rest}${url.search}`, 301);
  }
  if (!business || business.status !== 'active') throw notFound('No encontramos esta administración.');

  if (rest === '/') return Response.redirect(`${url.origin}/${slug}/admin/`, 302);
  if (rest === '/admin' || rest.startsWith('/admin/')) {
    if (rest.startsWith('/admin/assets/')) return assetAt(env, req, rest);
    const page = rest.replace(/\.html$/, '').replace(/\/$/, '');
    if (page !== '/admin/login' && !(await loadSession(req, env))) {
      return Response.redirect(`${url.origin}/${slug}/admin/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    return keepPrefix(await assetAt(env, req, rest), `/${slug}`, url);
  }
  throw notFound();
}

// /admin/… sin negocio: se lleva al negocio de donde viene (Referer) o al del usuario.
async function handleLegacyAdmin(req, env, url) {
  if (url.pathname.startsWith('/admin/assets/')) return env.ASSETS.fetch(req);
  let slug = null;
  const ref = req.headers.get('referer');
  if (ref) {
    try {
      const r = new URL(ref);
      const s = r.origin === url.origin && slugFromPath(r.pathname);
      if (s && (r.pathname === `/${s}/admin` || r.pathname.startsWith(`/${s}/admin/`))) slug = s;
    } catch { /* Referer inválido */ }
  }
  const session = await loadSession(req, env);
  // Con sesión, solo se sigue al negocio de origen si la persona es miembro (evita bucles).
  if (slug && session && !(await isMember(env, session.user_id, slug))) slug = null;
  if (!slug && session) slug = await defaultSlug(env, session);
  if (slug) return Response.redirect(`${url.origin}/${slug}${url.pathname}${url.search}`, 302);
  if (!session) {
    // El login genérico vive en la raíz "/". /admin/login (también con #invite=…) redirige ahí:
    // el navegador conserva el fragmento.
    const isLogin = /^\/admin\/login(\.html)?$/.test(url.pathname);
    const isHome = /^\/admin\/?$/.test(url.pathname);
    const next = isLogin ? url.search : isHome ? '' : `?next=${encodeURIComponent(url.pathname + url.search)}`;
    return Response.redirect(`${url.origin}/${next}`, 302);
  }
  return env.ASSETS.fetch(req);  // sesión sin negocios
}

function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const isApi = url.pathname.startsWith('/api/');
    try {
      if (isApi) return withHeaders(await handleApi(req, env, ctx, url), SECURITY_HEADERS);
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        return withHeaders(await handleLegacyAdmin(req, env, url), SECURITY_HEADERS);
      }
      // Raíz: login genérico (sin negocio en la URL). Con sesión, directo a su negocio.
      if (url.pathname === '/') {
        const session = await loadSession(req, env);
        if (session) {
          const s = await defaultSlug(env, session);
          return Response.redirect(`${url.origin}${s ? `/${s}` : ''}/admin/`, 302);
        }
        return withHeaders(await assetAt(env, req, '/admin/login'), SECURITY_HEADERS);
      }
      const slug = slugFromPath(url.pathname);
      if (slug) return withHeaders(await handleBusinessPath(req, env, url, slug), SECURITY_HEADERS);
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
