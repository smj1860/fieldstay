-- Templates Hub — Pass 3: Inventory
--
-- Tracks which inventory_templates row a given inventory_items row's
-- content came from — per item, not per property, since a property can
-- have items from more than one applied template, hand-added items, or
-- items that predate this system. Without this, "which properties use
-- this template" (Saved Templates) and "which template does this
-- property use" (Par Levels) can't be answered at all — see self-audit
-- in CLAUDE_TEMPLATES_3_INVENTORY.md.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS source_template_id uuid
    REFERENCES public.inventory_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_items_source_template_id
  ON public.inventory_items (source_template_id)
  WHERE source_template_id IS NOT NULL;

-- Guards seedOrgInventoryCatalogIfNeeded (lib/inventory/seed-org-catalog.ts)
-- against duplicating an org's entire ~115-row starter catalog if it's
-- ever invoked twice concurrently for the same org (e.g. two tabs loading
-- the Master List page at once). The seed function does a cheap
-- count-then-skip fast path first, but the actual insert goes through
-- upsert(..., { onConflict: 'org_id,name', ignoreDuplicates: true }) so
-- the race window between that check and the write can't produce
-- duplicate rows — the DB constraint is the real guard, not the
-- application-level check, per CLAUDE.md's TOCTOU guidance. This is a
-- deliberate addition beyond what the pass doc specified verbatim: the
-- doc's seeding shape mirrors seedDefaultRoomTemplatesIfNeeded, whose
-- own item-level duplication risk was accepted as low-consequence
-- specifically because a parent-level unique constraint (room_templates'
-- UNIQUE (org_id, name)) already bounded the blast radius to a handful of
-- task rows under one template. org_inventory_catalog had no equivalent
-- constraint at all, so an unguarded race here would duplicate the
-- entire catalog, not a handful of rows — different consequence, so a
-- different (cheap) fix.
CREATE UNIQUE INDEX IF NOT EXISTS org_inventory_catalog_org_name_unique
  ON public.org_inventory_catalog (org_id, name);
