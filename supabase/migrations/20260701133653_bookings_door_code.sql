
-- Door code storage on bookings table.
-- Populated by the OwnerRez entity_update webhook when categories includes
-- "doorcode". The value comes from GET /v2/bookings/{id} door_codes[0].code.
-- Stored per-booking (not per-property) since lock codes are booking-specific.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS door_code        TEXT,
  ADD COLUMN IF NOT EXISTS door_code_lock   TEXT,   -- lock_names from OwnerRez
  ADD COLUMN IF NOT EXISTS door_code_synced_at TIMESTAMPTZ;
