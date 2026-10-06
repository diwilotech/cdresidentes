-- Ingreso al portal de propietarios con apartamento + cédula del propietario (sin correo ni contraseña).
-- La sesión queda atada a la unidad; incluye las demás unidades del negocio con la misma cédula.
CREATE TABLE portal_sessions (
  id          TEXT PRIMARY KEY,             -- SHA-256 del token de la cookie cdr_portal
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  unit_id     TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  doc_hash    TEXT NOT NULL,                -- SHA-256 de la cédula con la que entró: si la administración la cambia, la sesión cae
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_portal_sessions_unit ON portal_sessions(business_id, unit_id);

-- Intentos fallidos por unidad: 5 errores bloquean esa unidad 15 minutos.
CREATE TABLE portal_logins (
  unit_id      TEXT PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
