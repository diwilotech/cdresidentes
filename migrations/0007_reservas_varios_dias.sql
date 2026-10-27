-- Reservas de varios días: date = primer día, end_date = último día (vacío = el mismo día).
ALTER TABLE bookings ADD COLUMN end_date TEXT;
