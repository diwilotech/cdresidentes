-- Esquema inicial multi-tenant de CD Residentes.
-- Un negocio = una administración de propiedad horizontal; puede manejar varios conjuntos (properties).
-- Toda tabla de datos lleva business_id y se filtra SIEMPRE por él (el valor sale de la sesión).

-- ---------- plataforma (mismo contrato que las demás apps de Diwilo) ----------

CREATE TABLE businesses (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  email       TEXT,
  phone       TEXT,
  timezone    TEXT NOT NULL DEFAULT 'America/Bogota',
  wa_instance TEXT,                         -- instancia de Evolution API
  logo_key    TEXT,                         -- R2
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  paid_until  TEXT,                         -- 'YYYY-MM-DD' inclusive; NULL = sin límite. Vencida -> solo lectura
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE business_slug_aliases (
  slug        TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_slug_aliases_business ON business_slug_aliases(business_id);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  pin_hash      TEXT,                       -- PBKDF2-SHA256 de la contraseña
  pin_salt      TEXT,
  failed_pins   INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  invite_hash   TEXT,                       -- SHA-256 del token del link para crear/restablecer la contraseña
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_invite ON users(invite_hash);

CREATE TABLE memberships (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','admin','staff')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, business_id)
);
CREATE INDEX idx_memberships_business ON memberships(business_id);
CREATE UNIQUE INDEX idx_memberships_one_owner ON memberships(business_id) WHERE role = 'owner';

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,             -- SHA-256 del token de la cookie
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  business_id TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------- copropiedades ----------

-- Conjunto / edificio (las "sedes" de la administración).
CREATE TABLE properties (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  nit         TEXT,
  address     TEXT,
  city        TEXT,
  phone       TEXT,
  email       TEXT,
  towers      TEXT,                         -- texto libre: "Torre A, Torre B"
  admin_fee   REAL,                         -- cuota de administración base por m² (opcional)
  logo_key    TEXT,                         -- R2
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_properties_business ON properties(business_id, status, name);

-- Unidad privada con su propietario y, si aplica, arrendatario.
CREATE TABLE units (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tower         TEXT,
  number        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'apartamento' CHECK (kind IN ('apartamento','casa','local','penthouse','parqueadero','deposito')),
  area_m2       REAL,
  coefficient   REAL,                       -- % de copropiedad
  owner_name    TEXT,
  owner_doc     TEXT,
  owner_phone   TEXT,
  owner_email   TEXT,
  tenant_name   TEXT,
  tenant_phone  TEXT,
  tenant_email  TEXT,
  occupancy     TEXT NOT NULL DEFAULT 'owner' CHECK (occupancy IN ('owner','tenant','vacant')),
  residents     INTEGER,
  vehicles      TEXT,                       -- placas
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_units_business ON units(business_id, property_id, tower, number);
CREATE UNIQUE INDEX idx_units_unique ON units(business_id, property_id, COALESCE(tower, ''), number);

-- Cartera: cada obligación de una unidad (cuota, extraordinaria, intereses…).
CREATE TABLE charges (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  unit_id     TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  concept     TEXT NOT NULL CHECK (concept IN ('admin','rtc','parking','ext','jur','int','other')),
  period      TEXT,                         -- 'YYYY-MM'
  description TEXT,
  amount      REAL NOT NULL,
  due_date    TEXT NOT NULL,                -- 'YYYY-MM-DD'
  paid_at     TEXT,                         -- 'YYYY-MM-DD' cuando se paga
  payment_ref TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_charges_business ON charges(business_id, paid_at, due_date);
CREATE INDEX idx_charges_unit ON charges(business_id, unit_id);
CREATE UNIQUE INDEX idx_charges_period ON charges(business_id, unit_id, concept, period) WHERE period IS NOT NULL AND concept = 'admin';

-- Solicitudes operativas y de portería: mudanzas, visitas, mantenimiento, domicilios, alarmas.
CREATE TABLE requests (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id      TEXT REFERENCES units(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('mudanza','visita','mantenimiento','domicilio','alarma','otro')),
  title        TEXT NOT NULL,
  detail       TEXT,
  scheduled_at TEXT,                        -- 'YYYY-MM-DDTHH:MM'
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','done')),
  resolution   TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_requests_business ON requests(business_id, status, scheduled_at);

-- PQRS de convivencia.
CREATE TABLE pqrs (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_id     TEXT REFERENCES units(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'queja' CHECK (kind IN ('peticion','queja','reclamo','sugerencia')),
  category    TEXT NOT NULL DEFAULT 'otro' CHECK (category IN ('ruido','mascotas','parqueadero','seguridad','mantenimiento','aseo','convivencia','otro')),
  subject     TEXT NOT NULL,
  detail      TEXT,
  reporter    TEXT,
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('baja','normal','alta')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  response    TEXT,
  closed_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pqrs_business ON pqrs(business_id, status, created_at);

-- Zonas comunes reservables y sus tarifas.
CREATE TABLE amenities (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  fee         REAL NOT NULL DEFAULT 0,
  fee_unit    TEXT NOT NULL DEFAULT 'evento' CHECK (fee_unit IN ('evento','hora','dia')),
  capacity    INTEGER,
  rules       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_amenities_business ON amenities(business_id, property_id);

CREATE TABLE bookings (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amenity_id  TEXT NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
  unit_id     TEXT REFERENCES units(id) ON DELETE SET NULL,
  date        TEXT NOT NULL,                -- 'YYYY-MM-DD'
  start_time  TEXT NOT NULL,                -- 'HH:MM'
  end_time    TEXT NOT NULL,
  holder      TEXT,
  amount      REAL,
  paid        INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bookings_business ON bookings(business_id, date);

-- Censo de mascotas.
CREATE TABLE pets (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  unit_id          TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  species          TEXT NOT NULL DEFAULT 'perro' CHECK (species IN ('perro','gato','ave','otro')),
  breed            TEXT,
  potentially_dangerous INTEGER NOT NULL DEFAULT 0,
  vaccinated_until TEXT,                    -- 'YYYY-MM-DD'
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pets_business ON pets(business_id, unit_id);

-- Comunicados y circulares.
CREATE TABLE notices (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id TEXT REFERENCES properties(id) ON DELETE CASCADE,   -- NULL = todos los conjuntos
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('mantenimiento','seguridad','servicios','asamblea','convivencia','finanzas','general')),
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
  sent_email  INTEGER NOT NULL DEFAULT 0,   -- destinatarios alcanzados
  sent_wa     INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notices_business ON notices(business_id, status, created_at);

-- Documentos y fotos en R2 (actas, soportes de pago, evidencias de PQRS, fotos de mascotas…).
CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ref_type     TEXT NOT NULL CHECK (ref_type IN ('property','unit','pqrs','request','notice','charge','pet')),
  ref_id       TEXT NOT NULL,
  r2_key       TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  content_type TEXT,
  size         INTEGER,
  uploaded_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_files_ref ON files(business_id, ref_type, ref_id);

-- Chat con Diwilo AI: conversaciones por usuario.
CREATE TABLE chats (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chats_user ON chats(business_id, user_id, updated_at);

CREATE TABLE chat_messages (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chat_messages ON chat_messages(business_id, chat_id, created_at);
