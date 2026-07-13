-- Backs the async data-plate scan pipeline: crew attach a photo from the
-- Assets & Maintenance page, an Inngest function runs Claude vision in the
-- background and fills in make/model/etc. — this column tracks that job's
-- progress so the UI (and a stalled-job audit later, if needed) can tell
-- "no scan requested" (null) apart from pending/processing/completed/failed.
CREATE TYPE asset_scan_status AS ENUM ('pending', 'processing', 'completed', 'failed');

ALTER TABLE public.property_assets
  ADD COLUMN IF NOT EXISTS scan_status asset_scan_status;
