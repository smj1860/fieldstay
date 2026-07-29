-- Featured amenities for guest SMS messaging — a PM can pick up to 3
-- amenities per property (falling back to the first synced ones if they
-- don't) plus a short guest-facing note for each, semicolon-separated. Wired
-- into the morning/evening SMS nudge crons as a message source independent
-- of the sponsor-recommendation system.

ALTER TABLE guidebook_property_configs
  ADD COLUMN IF NOT EXISTS featured_amenities text[] NULL,
  ADD COLUMN IF NOT EXISTS featured_amenity_notes text NULL;
