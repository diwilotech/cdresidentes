-- Portal de propietarios y residentes: cada usuario se vincula a una o varias unidades de un negocio.
-- No es una membresía (no entra al panel /admin): solo ve /<slug>/portal con los datos de sus unidades.
CREATE TABLE residents (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  unit_id     TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL DEFAULT 'owner' CHECK (relation IN ('owner','tenant')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, unit_id)
);
CREATE INDEX idx_residents_business ON residents(business_id, unit_id);
CREATE INDEX idx_residents_user ON residents(user_id, business_id);

-- Quién registró la mascota o la reserva desde el portal (NULL = la administración).
ALTER TABLE pets ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
