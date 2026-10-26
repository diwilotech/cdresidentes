// Bitácora: quién hizo qué, cuándo y desde dónde (app, mcp o diwilo). Nunca guarda contraseñas ni tokens.
export async function audit(c, accion, { modulo = c.module?.id || null, detalle = null, origen = c.origin || 'app' } = {}) {
  try {
    await c.env.DB.prepare('INSERT INTO audit_log (business_id, user_id, origen, modulo, accion, detalle) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(c.businessId, c.session?.user_id || null, origen, modulo, String(accion).slice(0, 120),
        detalle == null ? null : (typeof detalle === 'string' ? detalle : JSON.stringify(detalle)).slice(0, 2000)).run();
    c.audited = true;
  } catch (e) {
    console.error('bitácora', e.message);
  }
}
