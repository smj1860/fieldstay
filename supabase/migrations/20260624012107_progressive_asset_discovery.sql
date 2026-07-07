-- Progressive Asset Discovery: extend property_assets with discovery/verification
-- fields, and let checklist_instance_items carry system-mandated, non-deletable
-- injected tasks for asset types not yet discovered on a property.

ALTER TABLE public.property_assets
  ADD COLUMN photo_url   text,
  ADD COLUMN is_na        boolean NOT NULL DEFAULT false,
  ADD COLUMN verified_at  timestamp with time zone;

-- Only one *active* row per (property_id, asset_type) drives discovery drop-off.
-- Historical/replaced assets (is_active = false) are exempt so the Asset Health
-- module can keep multiple rows per asset_type over a property's lifetime.
CREATE UNIQUE INDEX property_assets_property_active_type_idx
  ON public.property_assets (property_id, asset_type)
  WHERE is_active = true;

ALTER TABLE public.checklist_instance_items
  ADD COLUMN is_mandatory          boolean NOT NULL DEFAULT false,
  ADD COLUMN non_deletable         boolean NOT NULL DEFAULT false,
  ADD COLUMN asset_discovery_type  text;
