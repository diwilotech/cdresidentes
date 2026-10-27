// Puente con «Diwilo Modulos» (Worker central de los módulos horizontales), por service binding MODULOS (RPC).
// La app verifica sesión, negocio, rol y que el módulo esté activo; el Worker central hace el resto con el contexto
// que le enviamos. Lo que registre en la bitácora vuelve aquí y se guarda en audit_log del negocio.
//   /api/<modulo>/…        API del módulo                 /staff/<modulo>.html   página (shell de la app + su <main>)
//   /m/<modulo>.js         código de la página            /l/:slug · /validar/:código · /c/…   rutas públicas de los módulos
//   centralTools(c)        herramientas de IA para el MCP de la app
import { HttpError } from './http.js';
import { CENTRALES, activeModuleIds, allModules, roleReaches, APP } from './modules.js';
import { TOOLS as OWN_TOOLS } from '../ia/index.js';
import { audit } from './audit.js';

export const isCentralApi = (path) => CENTRALES.some((id) => path === `/api/${id}` || path.startsWith(`/api/${id}/`));
const centralOf = (path) => CENTRALES.find((id) => path.startsWith(`/api/${id}`));

const need = (env) => { if (!env.MODULOS) throw new HttpError(503, 'Falta la conexión con Diwilo Modulos (service binding MODULOS)'); return env.MODULOS; };

export async function ctxOf(c) {
  const name = c.session?.business_name ?? (await c.env.DB.prepare('SELECT name FROM businesses WHERE id = ?').bind(c.businessId).first())?.name;
  const st = await c.env.DB.prepare('SELECT s.tema, s.modo, COALESCE(s.logo_key, b.logo_key) AS logo_key FROM businesses b LEFT JOIN business_settings s ON s.business_id = b.id WHERE b.id = ?').bind(c.businessId).first();
  const logo = st?.logo_key ? '/api/settings/logo' : null, tema = st?.tema || APP.tema, modo = st?.modo === 'dark' ? 'dark' : 'light';
  const activos = new Set(await activeModuleIds(c.env, c.businessId));
  return {
    app: APP.id, business: { id: c.businessId, name: name || null, logo, tema, modo }, role: c.role, readOnly: !!c.readOnly,
    user: { id: c.session?.user_id || null, email: c.session?.email || null, name: c.session?.name || null },
    origin: c.url?.origin || null, via: c.origin === 'mcp' ? 'mcp' : 'app', modulos: CENTRALES.filter((id) => activos.has(id)),
  };
}

// Escribe en la bitácora del negocio lo que hizo el módulo central.
async function saveAudit(c, entries = []) {
  if (!entries.length) return;
  await c.env.DB.batch(entries.map((e) => c.env.DB.prepare('INSERT INTO audit_log (business_id, user_id, origen, modulo, accion, detalle) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(c.businessId, c.session?.user_id || null, e.origen || c.origin || 'app', e.modulo, e.accion, e.detalle))).catch((x) => console.error('bitácora central', x.message));
  c.audited = true;
}

// Lo propio de esta app para la IA del módulo central «ai» (asistente, agentes, guías): sus módulos con su guía de uso y sus herramientas, y cómo
// ejecutarlas. Las ejecuta la APP con la sesión de quien hizo la llamada (mismo rol, módulo activo, solo lectura y bitácora), no el Worker central.
// Se entrega por RPC en ctx.propias (las funciones viajan como llamadas de vuelta, válidas mientras dura la petición).
export async function propiasDe(c) {
  const activos = new Set(await activeModuleIds(c.env, c.businessId));
  const mods = (await allModules(c.env)).filter((m) => m.tipo === 'propio' && activos.has(m.id) && roleReaches(c.role, m.permisos?.ver || 'staff'));
  const tools = OWN_TOOLS.filter((t) => (!t.modulo || activos.has(t.modulo)) && roleReaches(c.role, t.rol || 'staff'));
  return {
    modulos: mods.map(({ id, nombre, descripcion, permisos, mcp }) => ({ id, nombre, descripcion: descripcion || null, permisos, mcp: mcp || null, tipo: 'propio' })),
    catalogo: tools.map(({ name, description, inputSchema, rol, tipo, modulo }) => ({ name, description, inputSchema, rol: rol || 'staff', tipo: tipo === 'escritura' ? 'escritura' : 'lectura', modulo })),
    async ejecutar(name, args) {
      const t = tools.find((x) => x.name === name);
      if (!t) return { ok: false, error: 'Herramienta no disponible para este negocio o rol', status: 404 };
      if (t.tipo === 'escritura' && c.readOnly) return { ok: false, error: 'La suscripción del negocio está vencida: solo lectura.', status: 402 };
      try {
        c.audited = false;
        const result = await t.run(c, args || {});
        if (t.tipo === 'escritura' && !c.audited) await audit(c, `IA: ${t.name}`, { modulo: t.modulo, detalle: args, origen: 'mcp' });
        return { ok: true, result };
      } catch (e) { return { ok: false, error: e instanceof HttpError ? e.message : 'Error al ejecutar la herramienta', status: e.status || 500 }; }
    },
  };
}

// API de un módulo central. Ya pasó authenticate(c, 'tenant:<modulo>') en src/index.js.
export async function centralApi(c) {
  const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? null : await c.req.text();
  const ctx = await ctxOf(c);
  if (c.url.pathname.startsWith('/api/ai/')) ctx.propias = await propiasDe(c);   // el asistente y los agentes usan también las herramientas propias de la app
  const r = await need(c.env).call(ctx, { method: c.req.method, path: c.url.pathname, query: c.url.search, body });
  await saveAudit(c, r.audit);
  return new Response(r.body, { status: r.status, headers: r.headers });
}
export const centralModuleOf = centralOf;

// Página de un módulo central: el shell de esta app (public/staff/index.html) con el <main> y el script del módulo.
export async function centralPage(env, req, id) {
  const [shellRes, main] = await Promise.all([env.ASSETS.fetch(new Request(new URL('/staff/', req.url), { headers: req.headers })), need(env).asset(`/m/${id}.html`)]);
  if (main.status !== 200) throw new HttpError(404, 'Página no encontrada');
  const shell = await shellRes.text();
  const titulo = /data-titulo="([^"]+)"/.exec(main.body)?.[1] || id;
  const html = shell
    .replace(/<main class="dw-main"[\s\S]*?<\/main>/, `<!-- Módulo «${id}» de Diwilo Modulos (Worker central) -->\n${main.body.trim()}`)
    .replace(/<title>[^<·]*·/, `<title>${titulo} ·`)
    .replace(/<script>window\.DW_KEEP_APP = 1;<\/script>\s*<script src="\/js\/residentes\.js"><\/script>\s*<script src="\/js\/pages\/inicio\.js"><\/script>\s*<script src="\/m\/dashboard\.js"><\/script>/, `<script src="/m/${id}.js"></script>`);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
export async function centralAsset(env, path) {
  const a = await need(env).asset(path);
  return new Response(a.body, { status: a.status, headers: { 'content-type': a.type, 'cache-control': 'no-cache' } });
}

// Rutas públicas: links de rastreo (Marketing) y validación de documentos (Finanzas), en el dominio de la app.
export async function centralPublic(env, url, req) {
  const notFound = () => new Response('Este enlace no existe.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (url.pathname.startsWith('/l/')) {
    if (!CENTRALES.includes('marketing')) return notFound();
    const l = await need(env).link(APP.id, decodeURIComponent(url.pathname.slice(3)));
    if (!l) return notFound();
    // Solo si el negocio sigue activo y tiene Marketing
    const biz = await env.DB.prepare("SELECT 1 FROM businesses WHERE id = ? AND status = 'active' AND archived_at IS NULL").bind(l.business_id).first();
    if (!biz || !(await activeModuleIds(env, l.business_id)).includes('marketing')) return notFound();
    await env.MODULOS.click(APP.id, l.id);
    // Destino de la propia app (/matricula): va a la página de ese negocio
    let destino = l.url;
    if (destino.startsWith('/c/')) destino = `${url.origin}${destino}`;   // una tarjeta: está en la raíz del dominio, no bajo el negocio
    else if (destino.startsWith('/')) {
      const b = await env.DB.prepare('SELECT slug FROM businesses WHERE id = ?').bind(l.business_id).first();
      destino = `${url.origin}/${b?.slug || ''}${destino}`;
    }
    return new Response(null, { status: 302, headers: { location: destino, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer-when-downgrade' } });
  }
  // Tarjetas de presentación (Marketing): /c/<slug>, su foto, íconos, manifest, vCard y service worker
  if (url.pathname.startsWith('/c/') && CENTRALES.includes('marketing')) {
    const r = await need(env).tarjeta(APP.id, decodeURIComponent(url.pathname.slice(3)), url.origin, { bot: /bot|crawl|spider|preview/i.test(req?.headers?.get('user-agent') || '') });
    if (r.business_id) {
      const biz = await env.DB.prepare("SELECT 1 FROM businesses WHERE id = ? AND status = 'active' AND archived_at IS NULL").bind(r.business_id).first();
      if (!biz || !(await activeModuleIds(env, r.business_id)).includes('marketing')) return notFound();
    }
    const body = r.base64 ? Uint8Array.from(atob(r.body), (ch) => ch.charCodeAt(0)) : r.body;
    return new Response(r.status === 302 ? null : body, { status: r.status, headers: r.headers });
  }
  // Chats de clientes (IA): /chat/<slug> (página), /chat/<slug>/widget.js (burbuja para webs y tarjetas) y /chat/<slug>/mensaje
  if (url.pathname.startsWith('/chat/') && CENTRALES.includes('ai')) {
    const r = await need(env).chat(APP.id, decodeURIComponent(url.pathname.slice(6)), { method: req.method, query: url.search, body: req.method === 'POST' ? (await req.text()).slice(0, 4000) : null,
      meta: { country: req.headers.get('cf-ipcountry'), ua: req.headers.get('user-agent') }, origin: url.origin });
    if (r.business_id) {
      const biz = await env.DB.prepare("SELECT 1 FROM businesses WHERE id = ? AND status = 'active' AND archived_at IS NULL").bind(r.business_id).first();
      if (!biz) return notFound();
    }
    return new Response(r.body, { status: r.status, headers: r.headers });
  }
  // Webhook de WhatsApp (módulo WhatsApp): /wa/<código> = verificación de Meta (GET) y mensajes entrantes (POST)
  if (url.pathname.startsWith('/wa/') && CENTRALES.includes('whatsapp')) {
    if (req.method !== 'GET' && req.method !== 'POST') return new Response('Método no permitido', { status: 405 });
    const slug = decodeURIComponent(url.pathname.slice(4));
    const dueno = await need(env).whatsappNegocio(APP.id, slug);
    if (!dueno) return notFound();
    const biz = await env.DB.prepare("SELECT 1 FROM businesses WHERE id = ? AND status = 'active' AND archived_at IS NULL").bind(dueno).first();
    if (!biz || !(await activeModuleIds(env, dueno)).includes('whatsapp')) return notFound();
    const r = await need(env).whatsapp(APP.id, slug, { method: req.method, query: url.search, body: req.method === 'POST' ? (await req.text()).slice(0, 1000000) : null, sig: req.headers.get('x-hub-signature-256') });
    return new Response(r.body, { status: r.status, headers: r.headers });
  }
  // API pública del negocio con clave (IA → Conexiones): solo lectura de conversaciones y contactos
  if (url.pathname.startsWith('/v1/') && CENTRALES.includes('ai')) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Solo GET' }), { status: 405, headers: { ...cors, 'content-type': 'application/json' } });
    const clave = /^Bearer\s+(\S+)/i.exec(req.headers.get('authorization') || '')?.[1] || '';
    const r = await need(env).apiPublica(APP.id, clave, url.pathname, url.search);
    return new Response(r.body, { status: r.status, headers: r.headers });
  }
  if (url.pathname.startsWith('/validar/') && CENTRALES.includes('finanzas')) {
    const r = await need(env).validar(APP.id, decodeURIComponent(url.pathname.slice(9)), url.origin);
    return new Response(r.body, { status: r.status, headers: { ...r.headers, 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' } });
  }
  return notFound();
}

// Herramientas de IA de los módulos centrales, con la misma forma que las de src/ia/ (las filtra y publica mcp.js).
let toolDefs = null, toolsAt = 0;
export async function centralTools(env) {
  if (!CENTRALES.length || !env.MODULOS) return [];
  if (!toolDefs || Date.now() - toolsAt > 300000) {
    try { toolDefs = (await env.MODULOS.tools()).filter((t) => CENTRALES.includes(t.modulo)); toolsAt = Date.now(); } catch (e) { console.error('herramientas centrales', e.message); toolDefs ||= []; }
  }
  return toolDefs.map((t) => ({ ...t, run: async (c, args) => {
    const r = await env.MODULOS.tool(await ctxOf(c), t.name, args);
    await saveAudit(c, r.audit);
    if (!r.ok) throw new HttpError(r.status || 500, r.error);
    return r.result;
  } }));
}

// Registros de cada módulo central del negocio (Diwilo avisa antes de quitar un módulo).
export async function centralUso(env, businessId) {
  if (!CENTRALES.length || !env.MODULOS) return {};
  try { const u = await env.MODULOS.uso(APP.id, businessId); return Object.fromEntries(CENTRALES.map((id) => [id, u[id] ?? 0])); } catch { return {}; }
}

