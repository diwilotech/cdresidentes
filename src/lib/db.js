// Acceso a D1.
//
// tenantDb(c) es el único camino para leer/escribir datos de un negocio:
// rechaza cualquier SQL que no mencione business_id, y el valor siempre
// sale de la sesión (c.businessId), nunca del cliente.
// En la tabla businesses la llave es `id`: márquese con /* business_id */.

const TENANT_FILTER = /\bbusiness_id\b/;

function wrap(DB, guard) {
  const prep = (sql, params) => {
    if (guard) guard(sql);
    return DB.prepare(sql).bind(...params);
  };
  return {
    all: async (sql, ...params) => (await prep(sql, params).all()).results,
    first: (sql, ...params) => prep(sql, params).first(),
    run: (sql, ...params) => prep(sql, params).run(),
    prepare: (sql, ...params) => prep(sql, params),
    batch: (stmts) => DB.batch(stmts),
  };
}

export function globalDb(env) {
  return wrap(env.DB, null);
}

export function tenantDb(c) {
  if (!c.businessId) throw new Error('tenantDb sin businessId');
  return wrap(c.env.DB, (sql) => {
    if (!TENANT_FILTER.test(sql)) throw new Error(`Consulta sin filtro business_id: ${sql.slice(0, 80)}`);
  });
}

export const uuid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
