-- Platform-managed, broadcastable inventory templates (e.g. the "Standard
-- FieldStay Inventory Template" tied to HD Supply purchasable items).
--
-- Unlike platform_seed_room_templates (which only affects brand-new orgs
-- going forward), this is broadcast to EXISTING orgs on demand, and an org's
-- copy stays linked back to its platform origin via
-- inventory_templates.source_platform_template_id so that adding an item to
-- the platform template later can be pushed out to every org that already
-- has it — see lib/inngest/functions/platform-inventory-template-broadcast.ts.

-- ── default_par_level on both catalog tables ───────────────────────────────
-- Mirrors default_unit: a suggested starting par level a template pre-fills
-- from when an org builds one from the master list, still overridable per
-- template/property. org_inventory_catalog is a full editable copy of
-- inventory_catalog (see seedOrgInventoryCatalogIfNeeded), so it gets the
-- same column.

ALTER TABLE inventory_catalog
  ADD COLUMN IF NOT EXISTS default_par_level numeric NOT NULL DEFAULT 1;

ALTER TABLE org_inventory_catalog
  ADD COLUMN IF NOT EXISTS default_par_level numeric NOT NULL DEFAULT 1;

-- ── platform_inventory_templates / _items ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.platform_inventory_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 200),
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_inventory_template_items (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_inventory_template_id  uuid NOT NULL REFERENCES public.platform_inventory_templates(id) ON DELETE CASCADE,
  -- RESTRICT, not the unspecified default: a catalog item referenced by a
  -- live platform template must be explicitly removed from the template
  -- first, not silently orphaned by deleting the catalog row out from
  -- under it.
  catalog_item_id                uuid NOT NULL REFERENCES public.inventory_catalog(id) ON DELETE RESTRICT,
  par_level                      numeric NOT NULL DEFAULT 1,
  preferred_brand                text,
  sort_order                     int NOT NULL DEFAULT 0,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform_inventory_template_id, catalog_item_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_inventory_template_items_template_id
  ON public.platform_inventory_template_items (platform_inventory_template_id);

CREATE INDEX IF NOT EXISTS idx_platform_inventory_template_items_catalog_item_id
  ON public.platform_inventory_template_items (catalog_item_id);

ALTER TABLE public.platform_inventory_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_inventory_template_items ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_inventory_templates      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_inventory_template_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_inventory_templates      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_inventory_template_items TO service_role;

-- Internal platform config, same as platform_seed_room_templates — read/
-- written only by the platform admin UI and the broadcast Inngest function
-- (service role).
CREATE POLICY "platform_inventory_templates_manage"
  ON public.platform_inventory_templates FOR ALL
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

CREATE POLICY "platform_inventory_template_items_manage"
  ON public.platform_inventory_template_items FOR ALL
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

-- ── Link an org's own inventory_templates row back to its platform origin ──
-- NULL for an org's own custom templates. ON DELETE SET NULL: deleting the
-- platform template definition should not delete every org's already-
-- broadcast copy, just stop it being tracked as linked to that origin.

ALTER TABLE inventory_templates
  ADD COLUMN IF NOT EXISTS source_platform_template_id uuid
    REFERENCES public.platform_inventory_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_templates_source_platform_template_id
  ON public.inventory_templates (source_platform_template_id);
