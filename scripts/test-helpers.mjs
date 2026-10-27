// Utilidades de la prueba de punta a punta (las usan scripts/test-local.mjs y las pruebas de cada módulo en tests/modulos/).
// Levanta la app en local junto a un Worker que hace de Diwilo (scripts/diwilo-local) y da clientes HTTP con cookies.
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const PORT = 8799;
export const APP = `http://localhost:${PORT}`;

let failed = 0;
export const check = (name, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok || !extra ? '' : ` — ${extra}`}`); if (!ok) failed++; };
export const failures = () => failed;
export const fail = () => { failed++; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startApp() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const dbName = pkg.scripts['db:migrate:local'].match(/apply (\S+)/)[1]; // el nombre de la base D1, no el del paquete
  // Si la app usa módulos centrales, levanta también «Diwilo Modulos» (carpeta hermana o DIWILO_MODULOS) con su base local.
  const centrales = JSON.parse(readFileSync('modulos.app.json', 'utf8')).centrales || [];
  const central = process.env.DIWILO_MODULOS || '../Diwilo Modulos';
  const extra = centrales.length ? ['-c', `${central}/wrangler.jsonc`] : [];
  if (centrales.length) {
    if (!existsSync(`${central}/wrangler.jsonc`)) throw new Error(`La app usa módulos centrales (${centrales.join(', ')}) y no encuentro Diwilo Modulos en ${central}`);
    execSync(`npx wrangler d1 migrations apply diwilo-modulos-db --local --persist-to "${process.cwd()}/.wrangler/state" -c "${central}/wrangler.jsonc"`, { stdio: 'ignore', env: { ...process.env, CI: '1' } });
  }
  const dev = spawn('npx', ['wrangler', 'dev', '-c', 'scripts/diwilo-local/wrangler.jsonc', '-c', 'wrangler.jsonc', ...extra, '--port', String(PORT), '--persist-to', '.wrangler/state'],
    { env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  dev.stderr.on('data', (d) => { if (process.env.DEV_LOG) process.stderr.write(d); });
  dev.stdout.on('data', () => {});
  process.on('exit', () => dev.kill());
  for (let i = 0; i < 120; i++) { try { await fetch(APP + '/'); break; } catch { await sleep(1000); } }
  return dev;
}

export async function diwilo(method, path, body) {
  return (await fetch(`${APP}/__diwilo`, { method: 'POST', body: JSON.stringify({ method, path, body }) })).json();
}

// Cada persona tiene su propio frasco de cookies.
export function client() {
  const jar = {};
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(APP + path, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(method !== 'GET' ? { 'x-app': '1' } : {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),   // Uint8Array = archivo crudo (el tipo va en headers)
    });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: res.status, data, headers: res.headers };
  };
}

export const mcp = (token, body) => fetch(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

// Negocio nuevo creado por Diwilo. Con { login: true } el propietario ya acepta la invitación y queda con sesión.
export async function newBusiness(name, { login = false } = {}) {
  const mail = `${name.toLowerCase().replace(/\W/g, '')}${Date.now()}${Math.floor(Math.random() * 1000)}@ejemplo.com`;
  const created = await diwilo('POST', '/businesses', { name: `${name} ${Date.now().toString(36)}`, owner_email: mail, paid_until: null });
  if (!created.data.invite_path) console.error('crear negocio falló', created.status, JSON.stringify(created.data).slice(0, 400));
  const token = new URLSearchParams(created.data.invite_path.split('#')[1]).get('invite');
  const app = client();
  if (login) await app('/api/admin/auth/invite', { method: 'POST', body: { token, password: 'clave-segura-1', name: 'Propietario' } });
  return { id: created.data.id, created, mail, token, app };
}

// Usuario adicional del negocio con un rol, ya con sesión.
export async function newMember(businessId, role) {
  const r = await diwilo('POST', `/businesses/${businessId}/users`, { email: `${role}${Date.now()}${Math.floor(Math.random() * 1000)}@ejemplo.com`, role });
  const app = client();
  const token = new URLSearchParams(r.data.invite_path.split('#')[1]).get('invite');
  await app('/api/admin/auth/invite', { method: 'POST', body: { token, password: 'clave-segura-1' } });
  return { id: r.data.id, app };
}
