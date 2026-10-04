export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message, code: err.code }, err.status);
  }
  console.error(err);
  return json({ error: 'Error interno del servidor' }, 500);
}

export function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

// --- Validación mínima de campos ---

export function str(v, { max = 200, required = false, label = 'campo' } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new HttpError(400, `${label} es obligatorio`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, `${label} supera ${max} caracteres`);
  return s;
}

export function num(v, { min = -Infinity, max = Infinity, label = 'campo' } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label} fuera de rango`);
  return n;
}

export function oneOf(v, options, { label = 'campo', fallback = null } = {}) {
  if (v === undefined || v === null || v === '') return fallback;
  if (!options.includes(v)) throw new HttpError(400, `${label} no es válido`);
  return v;
}

export function date(v, { required = false, label = 'fecha', withTime = false } = {}) {
  if (!v) {
    if (required) throw new HttpError(400, `${label} es obligatoria`);
    return null;
  }
  const re = withTime ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
  const s = String(v).slice(0, withTime ? 16 : 10);
  if (!re.test(s) || Number.isNaN(Date.parse(withTime ? s + ':00Z' : s))) {
    throw new HttpError(400, `${label} no es válida`);
  }
  return s;
}

export function email(v, opts = {}) {
  const s = str(v, { max: 254, ...opts });
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, `${opts.label || 'correo'} no es válido`);
  return s ? s.toLowerCase() : null;
}
