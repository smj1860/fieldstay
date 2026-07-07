-- Phase 10: flag confirmed bookings that overlap another confirmed booking
-- on the same property. Populated by detectAndFlagOverlaps() — see
-- lib/ical/conflict-detection.ts. Surfaced as a badge on the Bookings page.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS has_overlap_conflict boolean NOT NULL DEFAULT false;

-- Speeds up the per-property confirmed-booking scan that runs on every
-- iCal sync and every manual booking create/cancel.
CREATE INDEX IF NOT EXISTS idx_bookings_property_overlap_scan
  ON bookings (property_id, checkin_date, checkout_date)
  WHERE status = 'confirmed';
