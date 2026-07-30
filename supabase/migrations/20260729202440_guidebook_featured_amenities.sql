-- Backfills the committed migration file for two columns that were already
-- applied directly to the live project (schema drift caught by
-- scripts/check-type-drift.mjs: guidebook_property_configs had
-- featured_amenities/featured_amenity_notes with no matching migration file
-- or types/database.ts entry). Column shapes below are taken verbatim from
-- the live schema (information_schema.columns) — not guessed. IF NOT EXISTS
-- makes this a no-op against the live project and a real add everywhere else.

ALTER TABLE guidebook_property_configs
  ADD COLUMN IF NOT EXISTS featured_amenities text[],
  ADD COLUMN IF NOT EXISTS featured_amenity_notes text;
