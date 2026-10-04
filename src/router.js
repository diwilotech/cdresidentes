import { HttpError } from './lib/http.js';

// Router mínimo: patrones con :param, un nivel de auth por ruta.
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, auth, handler) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${source}/?$`), keys, auth, handler });
    return this;
  }

  get(p, auth, h) { return this.add('GET', p, auth, h); }
  post(p, auth, h) { return this.add('POST', p, auth, h); }
  put(p, auth, h) { return this.add('PUT', p, auth, h); }
  patch(p, auth, h) { return this.add('PATCH', p, auth, h); }
  delete(p, auth, h) { return this.add('DELETE', p, auth, h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    throw pathMatched ? new HttpError(405, 'Método no permitido') : new HttpError(404, 'Ruta no encontrada');
  }
}
