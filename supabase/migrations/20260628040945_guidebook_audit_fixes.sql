ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS guidebook_pre_arrival_email_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_bookings_guidebook_pre_arrival_pending
  ON bookings (checkin_date)
  WHERE guidebook_pre_arrival_email_sent_at IS NULL;

CREATE POLICY "gc_restrict_insert"
  ON guidebook_configurations FOR INSERT
  WITH CHECK (false);

CREATE POLICY "gc_restrict_delete"
  ON guidebook_configurations FOR DELETE
  USING (false);
