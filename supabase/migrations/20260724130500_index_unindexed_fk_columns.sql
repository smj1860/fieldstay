-- Add covering indexes for the six FK columns that had none
-- (2026-07-24 audit). An unindexed FK makes every DELETE/UPDATE on the
-- referenced table sequential-scan the referencing table to enforce the
-- constraint (and ON DELETE SET NULL/CASCADE actions pay it too).
--
-- Enforced going forward by scripts/check-db-invariants.mjs (CI
-- db-invariants job): any new FK column without a covering index fails CI.

CREATE INDEX IF NOT EXISTS idx_org_inventory_catalog_platform_item
  ON public.org_inventory_catalog (platform_catalog_item_id);

CREATE INDEX IF NOT EXISTS idx_org_maintenance_catalog_items_platform_item
  ON public.org_maintenance_catalog_items (platform_catalog_item_id);

CREATE INDEX IF NOT EXISTS idx_organizations_bedroom_room_template
  ON public.organizations (bedroom_room_template_id);

CREATE INDEX IF NOT EXISTS idx_organizations_bathroom_room_template
  ON public.organizations (bathroom_room_template_id);

CREATE INDEX IF NOT EXISTS idx_pending_oauth_authorizations_provider
  ON public.pending_oauth_authorizations (provider_id);

CREATE INDEX IF NOT EXISTS idx_vendor_assignment_outcomes_property
  ON public.vendor_assignment_outcomes (property_id);
