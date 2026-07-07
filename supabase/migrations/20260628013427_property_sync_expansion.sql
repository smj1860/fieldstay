
-- ─────────────────────────────────────────────────────────────
-- Expand properties table with fields from OwnerRez detail
-- and listings (amenities) endpoints
-- ─────────────────────────────────────────────────────────────
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS house_manual           TEXT,
  ADD COLUMN IF NOT EXISTS checkout_instructions  TEXT,
  ADD COLUMN IF NOT EXISTS amenities              JSONB,
  ADD COLUMN IF NOT EXISTS smoking_allowed        BOOLEAN,
  ADD COLUMN IF NOT EXISTS pets_allowed           BOOLEAN,
  ADD COLUMN IF NOT EXISTS max_pets               INTEGER,
  ADD COLUMN IF NOT EXISTS events_allowed         BOOLEAN,
  ADD COLUMN IF NOT EXISTS min_renter_age         INTEGER;

-- GIN index for amenity-type queries (guidebook slot matching)
CREATE INDEX IF NOT EXISTS properties_amenities_idx
  ON properties USING gin(amenities)
  WHERE amenities IS NOT NULL;
