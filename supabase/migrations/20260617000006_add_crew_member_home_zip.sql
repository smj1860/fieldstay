-- Task 9: Mapbox geocoding — crew_members on save
--
-- crew_members has home_lat/home_lng (used by auto-assign-turnover.ts proximity
-- scoring) but no source field to geocode them from. vendors already solved this
-- with service_zip -> geocodeZip(); mirror that here with home_zip rather than
-- introducing a new full-address geocoder (Mapbox postcode endpoint takes a ZIP,
-- not a street address, and no address field exists anywhere on this table).

ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS home_zip text;
