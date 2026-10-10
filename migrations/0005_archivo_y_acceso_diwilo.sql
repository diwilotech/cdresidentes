-- Diwilo Web: archivar negocios (se borran por lotes a los 20 días) y entrar como el propietario sin contraseña.
ALTER TABLE businesses ADD COLUMN archived_at TEXT;

-- Pases de un solo uso (2 minutos) para que Diwilo abra la app como el propietario. Solo se guarda el SHA-256.
CREATE TABLE IF NOT EXISTS sso_tickets (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
