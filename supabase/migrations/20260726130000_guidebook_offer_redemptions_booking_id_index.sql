-- guidebook_offer_redemptions.booking_id (FK to bookings, ON DELETE SET NULL,
-- added by 20260726100000_guidebook_v2_foundation.sql) had no covering index —
-- the two indexes that migration added cover (sponsor_id, opened_at) and
-- (org_id, opened_at) only, neither of which covers a bare booking_id lookup.
-- An unindexed FK sequential-scans guidebook_offer_redemptions on every
-- bookings DELETE/UPDATE that touches booking_id (per the db-invariants
-- check-db-invariants.mjs FK-coverage gate, CLAUDE.md's structural
-- enforcement Tier 4).

CREATE INDEX IF NOT EXISTS idx_guidebook_offer_redemptions_booking_id
  ON guidebook_offer_redemptions (booking_id);
