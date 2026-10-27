// MCP (Model Context Protocol) del negocio: el negocio conecta su propio asistente (Claude u otro) a su app.
// JSON-RPC 2.0 sobre HTTP en POST /mcp, sin dependencias. Acceso con un token del negocio:
//   Authorization: Bearer <token>   (se genera en Configuración → IA → Conexiones; se guarda solo el SHA-256)
// El token queda atado al negocio y al usuario que lo creó: las herramientas usan su rol actual,
// solo aparecen las de módulos activos y nunca se usa la contraseña.
// Las de escritura se marcan (destructiveHint) para que el asistente pida confirmación, y quedan en la bitácora.
//
// Tokens (sesión normal de la app):
//   GET    /api/ia/tokens          los del usuario (owner/admin ven todos los del negocio)
//   POST   /api/ia/tokens          { name } -> { token } se muestra una sola vez
//   DELETE /api/ia/tokens/:id      revocar
import { json, readJson, HttpError, str } from '../lib/http.js';
import { db, uuid, nowIso } from '../lib/db.js';
import { randomHex, sha256Hex, isExpired } from '../lib/auth.js';
import { activeModuleIds, roleReaches, parseModulos, OWN_IDS, APP } from '../lib/modules.js';
import { audit } from '../lib/audit.js';
import { TOOLS } from '../ia/index.js';
import { centralTools, ctxOf, propiasDe } from '../lib/central.js';

// Los clientes de IA solo aceptan [a-zA-Z0-9_-] en el nombre: «items.listar» se publica como «items_listar».
const wire = (name) => name.replace(/\./g, '_');
const PROTOCOL = '2025-06-18';

// Guías de uso de los módulos de este negocio y este rol: UN estándar para todos (src/lib/guias.js de Diwilo Modulos), el mismo que usan el asistente y los agentes.
// Los módulos propios de la app mandan su manifiesto y sus herramientas en ctx.propias.
export async function guiasDe(c, origin) {
  if (!c.env.MODULOS) throw new HttpError(503, 'Las guías de uso no están disponibles (falta la conexión con Diwilo Modulos)');
  return c.env.MODULOS.guias({ ...(await ctxOf(c)), origin, propias: await propiasDe(c) });
}
export async function guiaDeModulo(c, id, origin) {
  const d = (await guiasDe(c, origin)).find((x) => x.modulo === id);
  if (!d) throw new HttpError(404, 'Módulo no encontrado');
  const { markdown, ...doc } = d;
  return doc;
}

async function tokenContext(c) {
  const m = /^Bearer\s+(dwm_[0-9a-f]{64})$/i.exec(c.req.headers.get('authorization') || '');
  if (!m) throw new HttpError(401, 'Falta el token de conexión (Authorization: Bearer …)');
  const t = await db(c.env).first(`SELECT t.id, t.business_id, t.user_id, mb.role, mb.modulos, b.paid_until, u.email, u.name
      FROM mcp_tokens t
      JOIN businesses b ON b.id = t.business_id AND b.status = 'active' AND b.archived_at IS NULL
      JOIN memberships mb ON mb.business_id = t.business_id AND mb.user_id = t.user_id
      JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`, await sha256Hex(m[1]));
  if (!t) throw new HttpError(401, 'Token no válido o revocado');
  await db(c.env).run('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?', nowIso(), t.id);
  Object.assign(c, { businessId: t.business_id, role: t.role, modulos: parseModulos(t.modulos), readOnly: isExpired(t.paid_until), origin: 'mcp',
    timezone: 'America/Bogota', user: { id: t.user_id, email: t.email, name: t.name }, session: { user_id: t.user_id, email: t.email, name: t.name } });
}

export async function availableTools(c) {
  const active = new Set(await activeModuleIds(c.env, c.businessId));
  return [...TOOLS, ...(await centralTools(c.env))].filter((t) => (!t.modulo || active.has(t.modulo)) && roleReaches(c.role, t.rol || 'staff'));
}

const describe = (t) => ({
  name: wire(t.name), description: t.description, inputSchema: t.inputSchema,
  annotations: { readOnlyHint: t.tipo !== 'escritura', destructiveHint: t.tipo === 'escritura', title: t.description },
});

async function handle(c, msg) {
  const { id, method, params = {} } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Petición no válida');
  if (method.startsWith('notifications/')) return null;
  if (method === 'initialize') return ok({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } }, serverInfo: { name: APP.id, title: APP.nombre, version: '1.0.0' },
    instructions: `Herramientas de ${APP.nombre} para el negocio conectado. Pide confirmación antes de usar herramientas que escriben. Cada módulo tiene su guía de uso: lee el recurso diwilo://<módulo>/guia (resources/list) o usa sus prompts (prompts/list).` });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: (await availableTools(c)).map(describe) });
  if (method === 'resources/list') {
    return ok({ resources: (await guiasDe(c, new URL(c.req.url).origin)).map((d) => ({ uri: `diwilo://${d.modulo}/guia`, name: `Guía de ${d.nombre}`, description: `Cómo usar el módulo ${d.nombre} con las herramientas del MCP`, mimeType: 'text/markdown' })) });
  }
  if (method === 'resources/read') {
    const id = /^diwilo:\/\/([a-z]+)\/guia$/.exec(String(params.uri || ''))?.[1];
    const d = id && (await guiasDe(c, new URL(c.req.url).origin)).find((x) => x.modulo === id);
    if (!d) return fail(-32002, 'Recurso no encontrado');
    return ok({ contents: [{ uri: params.uri, mimeType: 'text/markdown', text: d.markdown }] });
  }
  if (method === 'prompts/list') {
    const out = [];
    for (const d of await guiasDe(c, new URL(c.req.url).origin)) for (const f of d.flujos) out.push({ name: `${d.modulo}_${f.id}`, title: f.nombre, description: f.descripcion || f.nombre, arguments: [] });
    return ok({ prompts: out });
  }
  if (method === 'prompts/get') {
    const [id, ...rest] = String(params.name || '').split('_'), fid = rest.join('_');
    const d = id && (await guiasDe(c, new URL(c.req.url).origin)).find((x) => x.modulo === id), f = d?.flujos.find((x) => x.id === fid);
    if (!f) return fail(-32602, 'Prompt no encontrado');
    return ok({ description: f.descripcion || f.nombre, messages: [{ role: 'user', content: { type: 'text', text: f.prompt } }] });
  }
  if (method === 'tools/call') {
    const tool = (await availableTools(c)).find((t) => wire(t.name) === params.name || t.name === params.name);
    if (!tool) return fail(-32602, 'Herramienta no disponible para este negocio o rol');
    if (tool.tipo === 'escritura' && c.readOnly) return ok({ isError: true, content: [{ type: 'text', text: 'La suscripción del negocio está vencida: solo lectura.' }] });
    try {
      c.audited = false;
      const out = await tool.run(c, params.arguments || {});
      if (tool.tipo === 'escritura' && !c.audited) await audit(c, `IA: ${tool.name}`, { modulo: tool.modulo, detalle: params.arguments, origen: 'mcp' });
      return ok({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
    } catch (e) {
      return ok({ isError: true, content: [{ type: 'text', text: e instanceof HttpError ? e.message : 'Error al ejecutar la herramienta' }] });
    }
  }
  return fail(-32601, `Método no soportado: ${method}`);
}

export async function mcpFetch(req, env, ctx) {
  if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST' } }); // sin SSE: respuestas JSON
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const c = { req, env, ctx, url: new URL(req.url) };
  try {
    await tokenContext(c);
  } catch (e) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: e.message } }, e.status || 401, { 'www-authenticate': 'Bearer' });
  }
  let body;
  try { body = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }, 400); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(c, m)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handle(c, body);
  return out ? json(out) : new Response(null, { status: 202 });
}

export function routes(r) {
  // Guía de uso de CADA módulo propio para el MCP: GET /api/<módulo>/mcp (los centrales la responde handleCentral con el mismo documento)
  for (const id of OWN_IDS) r.get(`/api/${id}/mcp`, `tenant:${id}`, async (c) => json(await guiaDeModulo(c, id, c.url.origin)));

  r.get('/api/ia/tokens', 'tenant', async (c) => {
    const all = ['owner', 'admin'].includes(c.role);
    return json({ tokens: await db(c.env).all(`SELECT t.id, t.name, t.created_at, t.last_used_at, t.revoked_at, u.email
      FROM mcp_tokens t JOIN users u ON u.id = t.user_id WHERE t.business_id = ? ${all ? '' : 'AND t.user_id = ?'} ORDER BY t.created_at DESC`,
      c.businessId, ...(all ? [] : [c.session.user_id])), url: `${c.url.origin}/mcp` });
  });

  r.post('/api/ia/tokens', 'tenant', async (c) => {
    const name = str((await readJson(c.req)).name, { max: 60, required: true, label: 'Nombre de la conexión' });
    const token = `dwm_${randomHex(32)}`;
    await db(c.env).run('INSERT INTO mcp_tokens (id, business_id, user_id, name, token_hash) VALUES (?, ?, ?, ?, ?)',
      uuid(), c.businessId, c.session.user_id, name, await sha256Hex(token));
    await audit(c, `Creó la conexión de IA «${name}»`, { modulo: 'ia' });
    return json({ token, url: `${c.url.origin}/mcp` }, 201);
  });

  r.delete('/api/ia/tokens/:id', 'tenant', async (c) => {
    const t = await db(c.env).first('SELECT user_id, name FROM mcp_tokens WHERE id = ? AND business_id = ?', c.params.id, c.businessId);
    if (!t) throw new HttpError(404, 'No encontrada');
    if (t.user_id !== c.session.user_id && !['owner', 'admin'].includes(c.role)) throw new HttpError(403, 'Solo puedes revocar tus conexiones');
    await db(c.env).run('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND business_id = ?', nowIso(), c.params.id, c.businessId);
    await audit(c, `Revocó la conexión de IA «${t.name}»`, { modulo: 'ia' });
    return json({ ok: true });
  });
}
