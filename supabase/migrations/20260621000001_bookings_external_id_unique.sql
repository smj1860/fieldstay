ALTER TABLE bookings
  ADD CONSTRAINT bookings_external_id_external_source_key
  UNIQUE (external_id, external_source);
