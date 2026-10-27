-- Base común de las apps de Diwilo para CD Residentes: apariencia por negocio, módulos por negocio (los asigna Diwilo),
-- bitácora, módulos por persona del equipo, autorización de datos y conexiones MCP. Solo agrega: no borra ni cambia lo existente.

-- Apariencia del negocio (la maneja el módulo Marca): tema de la paleta cerrada y modo claro/oscuro. El logo del negocio sigue en businesses.logo_key.
CREATE TABLE IF NOT EXISTS business_settings (
  business_id  TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  tema         TEXT NOT NULL DEFAULT 'turquesa',   -- azul | indigo | violeta | rosa | rojo | naranja | verde | turquesa | grafito
  modo         TEXT NOT NULL DEFAULT 'light',      -- light | dark
  logo_key     TEXT,
  updated_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Copia local de los módulos efectivos que asigna Diwilo (plan + excepciones). Sin filas y sin gestión de Diwilo = todos activos.
CREATE TABLE IF NOT EXISTS business_modules (
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  modulo       TEXT NOT NULL,
  activo       INTEGER NOT NULL DEFAULT 1,
  desde        TEXT,
  hasta        TEXT,
  synced_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (business_id, modulo)
);
CREATE TABLE IF NOT EXISTS business_modules_sync (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Bitácora: quién hizo qué. Las herramientas de IA que escriben también quedan aquí.
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id      TEXT,
  origen       TEXT NOT NULL DEFAULT 'app',       -- app | mcp | diwilo
  modulo       TEXT,
  accion       TEXT NOT NULL,
  detalle      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS audit_log_business ON audit_log (business_id, created_at);

-- Módulos que puede abrir cada persona del equipo. NULL = los de su rol (propietario y administrador ven todo).
ALTER TABLE memberships ADD COLUMN modulos TEXT;

-- Autorización de tratamiento de datos (Ley 1581) y mayoría de edad, al aceptar la invitación.
ALTER TABLE users ADD COLUMN consent_at TEXT;
ALTER TABLE users ADD COLUMN consent_version TEXT;
ALTER TABLE users ADD COLUMN adult_confirmed_at TEXT;

-- Conexiones MCP: el usuario genera un token en IA → Conexiones. Se guarda solo el SHA-256.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at  TEXT,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS mcp_tokens_business ON mcp_tokens (business_id);
