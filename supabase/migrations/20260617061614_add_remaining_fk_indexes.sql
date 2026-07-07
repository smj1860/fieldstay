CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_id
  ON integration_connections(provider_id);

CREATE INDEX IF NOT EXISTS idx_turnovers_prev_booking_id
  ON turnovers(prev_booking_id);
