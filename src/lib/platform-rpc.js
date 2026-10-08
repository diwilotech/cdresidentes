// Diwilo Web administra esta app (negocios, usuarios, suscripción) por RPC sobre un service binding:
// llama a Platform.call() desde su propio Worker. Esa entrada no tiene URL pública, así que no hace
// falta ninguna clave compartida: solo un Worker de la misma cuenta con el binding puede usarla.
// Por dentro se arma una petición a /api/platform/* y pasa por las mismas rutas de siempre; las
// peticiones creadas aquí quedan marcadas y son las únicas que esas rutas aceptan.
const trusted = new WeakSet();

export const isPlatformCall = (request) => trusted.has(request);

export async function platformCall(worker, env, ctx, method, path, body, origin) {
  if (typeof path !== 'string' || !path.startsWith('/')) return { status: 400, data: { error: 'ruta inválida' } };
  const base = /^https:\/\/[a-z0-9.-]+$/i.test(origin || '') ? origin : 'https://platform.internal';
  const request = new Request(`${base}/api/platform${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  trusted.add(request);
  const res = await worker.fetch(request, env, ctx);
  const text = res.status === 204 ? '' : await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  return { status: res.status, data };
}
