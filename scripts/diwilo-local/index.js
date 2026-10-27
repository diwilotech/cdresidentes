// SOLO LOCAL. Hace de Diwilo Web delante de la app:
//   POST /__diwilo { method, path, body } -> APP.call(...) por RPC, igual que callApp en Diwilo Web
//   cualquier otra ruta                   -> la app tal cual (como si fuera su dominio)
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/__diwilo' && req.method === 'POST') {
      const { method, path, body } = await req.json();
      return Response.json(await env.APP.call(method, path, body, url.origin));
    }
    return env.WEB.fetch(req);
  },
};
