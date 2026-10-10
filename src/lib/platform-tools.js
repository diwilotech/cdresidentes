// Archivo y borrado definitivo de negocios (lo usa la API de plataforma, que solo llama Diwilo Web por RPC).
// Un negocio archivado no se puede usar; pasados `days` días, purgeArchived lo borra por lotes:
//   1. las filas de todas las tablas que tienen la columna del negocio (y las tablas puente que cuelgan
//      de ellas por llave foránea), de las hijas a las padres para respetar las llaves foráneas;
//   2. los archivos de R2 guardados con el prefijo "<id del negocio>/";
//   3. el negocio.
// Cada llamada tiene un presupuesto de tiempo y de consultas; lo que falte sigue en la siguiente.
const SKIP = /^(sqlite_|_cf_|d1_)/;

async function rows(env, sql, ...args) {
  return (await env.DB.prepare(sql).bind(...args).all()).results;
}

// Tablas a vaciar, en orden de borrado (hijas primero).
async function plan(env, cfg) {
  const tables = (await rows(env, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name).filter((n) => !SKIP.test(n) && n !== cfg.table);
  const info = {};
  for (const t of tables) {
    const cols = (await rows(env, "SELECT name FROM pragma_table_info(?)", t)).map((c) => c.name);
    const fks = await rows(env, 'SELECT "table" AS parent, "from" AS col, "to" AS pcol FROM pragma_foreign_key_list(?)', t);
    info[t] = { tenant: cols.includes(cfg.tenantCol), fks: fks.filter((f) => f.parent !== t) };
  }
  // Tablas del negocio y tablas puente sin la columna pero que apuntan a una del negocio.
  const steps = [];
  for (const [t, i] of Object.entries(info)) {
    if (i.tenant) steps.push({ t, where: `"${cfg.tenantCol}" = ?` });
    else {
      const fk = i.fks.find((f) => info[f.parent]?.tenant);
      if (fk) steps.push({ t, where: `"${fk.col}" IN (SELECT "${fk.pcol || "id"}" FROM "${fk.parent}" WHERE "${cfg.tenantCol}" = ?)` });
    }
  }
  // Orden: una tabla se borra cuando ya se borraron las que la referencian.
  const names = new Set(steps.map((s) => s.t));
  const refs = Object.fromEntries(steps.map((s) => [s.t, new Set()]));
  for (const s of steps) for (const f of info[s.t].fks) if (names.has(f.parent)) refs[f.parent].add(s.t);
  const done = new Set(), order = [];
  while (order.length < steps.length) {
    const next = steps.find((s) => !done.has(s.t) && [...refs[s.t]].every((c) => done.has(c)))
      || steps.find((s) => !done.has(s.t)); // ciclo: sigue igual (fallará solo si hay llaves sin cascada)
    done.add(next.t);
    order.push(next);
  }
  return order;
}

// Borra en trozos de `chunk` filas. Devuelve false si se acabó el presupuesto antes de terminar.
async function drain(env, step, id, chunk, budget) {
  for (;;) {
    if (budget.left() <= 0) return false;
    let res;
    try {
      res = await env.DB.prepare(`DELETE FROM "${step.t}" WHERE rowid IN (SELECT rowid FROM "${step.t}" WHERE ${step.where} LIMIT ${chunk})`).bind(id).run();
    } catch (e) {
      if (!/rowid/i.test(String(e.message))) throw e;
      res = await env.DB.prepare(`DELETE FROM "${step.t}" WHERE ${step.where}`).bind(id).run(); // tabla WITHOUT ROWID
    }
    budget.queries++;
    if (!res.meta?.changes || res.meta.changes < chunk) return true;
  }
}

async function dropFiles(bucket, id, budget) {
  if (!bucket) return true;
  let cursor;
  do {
    if (budget.left() <= 0) return false;
    const list = await bucket.list({ prefix: `${id}/`, limit: 1000, cursor });
    budget.queries++;
    if (list.objects.length) { await bucket.delete(list.objects.map((o) => o.key)); budget.queries++; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return true;
}

// cfg: { table, tenantCol, archivedCol = 'archived_at', bucket?, after?(env, id) }
export async function purgeArchived(env, cfg, { days = 20, maxBusinesses = 3, chunk = 500, maxQueries = 400, maxMs = 20000 } = {}) {
  const archived = cfg.archivedCol || "archived_at";
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const due = await rows(env, `SELECT id FROM "${cfg.table}" WHERE "${archived}" IS NOT NULL AND "${archived}" < ? ORDER BY "${archived}" LIMIT ?`, cutoff, maxBusinesses);
  const t0 = Date.now();
  const budget = { queries: 0, left: () => Math.min(maxQueries - budget.queries, maxMs - (Date.now() - t0)) };
  const purged = [], errors = [];
  if (!due.length) return { purged, pending: 0, errors };
  const steps = await plan(env, cfg);
  for (const { id } of due) {
    try {
      let complete = true;
      for (const step of steps) if (!(await drain(env, step, id, chunk, budget))) { complete = false; break; }
      if (complete) complete = await dropFiles(cfg.bucket, id, budget);
      if (!complete) break; // sigue en la próxima llamada
      await env.DB.prepare(`DELETE FROM "${cfg.table}" WHERE id = ?`).bind(id).run();
      if (cfg.after) await cfg.after(env, id);
      purged.push(id);
    } catch (e) {
      errors.push({ id, error: String(e.message || e).slice(0, 300) });
    }
  }
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${cfg.table}" WHERE "${archived}" IS NOT NULL AND "${archived}" < ?`).bind(cutoff).first();
  return { purged, pending: left.n, errors };
}

// Fecha en la que se borrará un negocio archivado (para mostrarla en Diwilo).
export const purgeDate = (archivedAt, days = 20) =>
  archivedAt ? new Date(Date.parse(archivedAt) + days * 86400000).toISOString().slice(0, 10) : null;

// ---------- Entrar como el dueño desde Diwilo (sin contraseña) ----------
// Diwilo pide por RPC un pase de un solo uso (2 minutos) y abre /api/sso?t=<pase> en la app; la app lo
// cambia por una sesión normal del dueño. En la base solo queda el SHA-256 del pase (tabla sso_tickets).
const SSO_MINUTES = 2;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (t) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));

export async function issueSsoTicket(env, businessId, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sso_tickets WHERE expires_at < ?").bind(new Date().toISOString()),
    env.DB.prepare("INSERT INTO sso_tickets (id, business_id, user_id, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), businessId, userId, new Date(Date.now() + SSO_MINUTES * 60000).toISOString()),
  ]);
  return token;
}

// Devuelve { business_id, user_id } y borra el pase (sirve una sola vez), o null si no vale.
export async function takeSsoTicket(env, token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ""))) return null;
  const id = await sha256(token);
  const row = await env.DB.prepare("SELECT business_id, user_id, expires_at FROM sso_tickets WHERE id = ?").bind(id).first();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM sso_tickets WHERE id = ?").bind(id).run();
  return row.expires_at > new Date().toISOString() ? row : null;
}
