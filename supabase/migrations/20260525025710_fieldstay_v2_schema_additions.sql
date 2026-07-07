
-- v2: avg_nightly_rate on properties (booking revenue auto-calculation)
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS avg_nightly_rate numeric(10,2) DEFAULT NULL;

-- v2: booking_id on owner_transactions (link revenue to specific booking)
ALTER TABLE owner_transactions
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_owner_txn_booking_id ON owner_transactions(booking_id);
