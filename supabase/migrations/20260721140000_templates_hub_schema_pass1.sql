-- ============================================================================
-- Templates Hub — Pass 1: Schema
--
-- Org-scoped inventory + maintenance catalogs, inventory_templates
-- multi-template support, room_templates delete-guard for seeded rows,
-- RLS standardization across all three template systems to the same
-- admin/manager/owner gate.
--
-- Explicitly OUT of scope for this migration:
--   - Dropping org_master_checklist_items / org_master_maintenance_schedules
--     — both still have live app code writing to them; dropped in the pass
--     that removes those specific onboarding pages, not here.
--   - Any seeding logic — that's application code, built in the
--     Inventory/Maintenance passes.
--   - maintenance_schedule_templates / maintenance_schedule_template_items
--     — has a pre-existing is_system mechanism that needs investigation
--     before Pass 4, not a schema change here.
-- ============================================================================

-- ── 1. Org-scoped inventory catalog ─────────────────────────────────────────
-- inventory_catalog stays the platform-curated global source (admin-only,
-- unchanged). Each org gets its own editable copy, seeded from it on first
-- touch (application code, Pass 2). platform_catalog_item_id is nullable /
-- ON DELETE SET NULL — a PM's own custom item never had a platform origin,
-- and a platform item retired later shouldn't take the org's copy with it.

CREATE TABLE IF NOT EXISTS public.org_inventory_catalog (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  platform_catalog_item_id  uuid REFERENCES public.inventory_catalog(id) ON DELETE SET NULL,
  name                      text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  category                  inventory_category NOT NULL DEFAULT 'other',
  default_unit              text NOT NULL DEFAULT 'units',
  description               text,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_inventory_catalog_org_id
  ON public.org_inventory_catalog (org_id);

CREATE OR REPLACE TRIGGER org_inventory_catalog_updated_at
  BEFORE UPDATE ON public.org_inventory_catalog
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.org_inventory_catalog ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.org_inventory_catalog TO authenticated;

CREATE POLICY "org_inventory_catalog_select"
  ON public.org_inventory_catalog FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "org_inventory_catalog_manage"
  ON public.org_inventory_catalog FOR ALL
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));


-- ── 2. Org-scoped maintenance catalog ───────────────────────────────────────
-- Same pattern, same reasoning, for maintenance_catalog_items — currently
-- global, no org_id, writable only by service_role (even more locked down
-- than inventory_catalog was, which at least had an admin UI).

CREATE TABLE IF NOT EXISTS public.org_maintenance_catalog_items (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  platform_catalog_item_id  uuid REFERENCES public.maintenance_catalog_items(id) ON DELETE SET NULL,
  name                      text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  category                  text NOT NULL,
  suggested_recurrence      text,
  asset_category            text,
  description               text,
  sort_order                integer NOT NULL DEFAULT 0,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_maintenance_catalog_items_org_id
  ON public.org_maintenance_catalog_items (org_id);

CREATE OR REPLACE TRIGGER org_maintenance_catalog_items_updated_at
  BEFORE UPDATE ON public.org_maintenance_catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.org_maintenance_catalog_items ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.org_maintenance_catalog_items TO authenticated;

CREATE POLICY "org_maintenance_catalog_items_select"
  ON public.org_maintenance_catalog_items FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "org_maintenance_catalog_items_manage"
  ON public.org_maintenance_catalog_items FOR ALL
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));


-- ── 3. inventory_templates: allow more than one per org ────────────────────
-- Was hard-limited to exactly one row per org (inventory_templates_org_unique
-- on org_id alone) — createOrGetTemplate() upserted against it as a
-- singleton. New rule: unique per (org_id, name), so an org can have as
-- many named templates as it wants, just not two sharing a name.

DROP INDEX IF EXISTS inventory_templates_org_unique;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_templates_org_name_unique
  ON public.inventory_templates (org_id, name);


-- ── 4. inventory_templates / inventory_template_items: RLS standardization ─
-- See self-audit items 1–3 in CLAUDE_TEMPLATES_1_SCHEMA.md for why these
-- changes were proposed. CORRECTION made during Pass 1 implementation: the
-- doc's self-audit assumed the live policies were still named "org members
-- can manage inventory templates(/ items)" using a raw organization_members
-- subquery. Live-schema verification (20260618000002_baseline_schema_snapshot.sql,
-- an introspection-based snapshot, plus 20260614122733 and the two
-- 20260617*_consolidate_multiple_permissive_policies.sql migrations that ran
-- after it) shows that assumption is stale: those policies were already
-- dropped and replaced by split select/insert/update/delete policies named
-- inventory_templates_select/insert/update/delete (and the _item_s
-- equivalents) that already use is_org_member()/get_user_org_ids() and
-- already gate writes to admin/manager (owner passes automatically via
-- is_org_member()'s always-pass rule). Dropping only the stale pre-2026-06-14
-- names, as the doc's draft did, would leave the live split policies in
-- place and then fail outright on CREATE POLICY "inventory_templates_select"
-- (name already in use). Dropping the actual live policy names here instead
-- so this migration is safe to run against the real database. The
-- functional upgrade that's still real and still applied: consolidating
-- four split policies into one _select + one _manage ALL policy per
-- CLAUDE.md's standard template, and adding 'owner' to the role array
-- explicitly for consistency with every other template table in this
-- migration (no behavior change — is_org_member() already let owner
-- through). Item 3 (anon grant) was verified still live and is fixed below
-- exactly as the doc specified.

DROP POLICY IF EXISTS "org members can manage inventory templates"      ON public.inventory_templates;
DROP POLICY IF EXISTS "org members can manage inventory template items" ON public.inventory_template_items;
DROP POLICY IF EXISTS "inventory_templates_write"                       ON public.inventory_templates;
DROP POLICY IF EXISTS "inventory_templates_select"                      ON public.inventory_templates;
DROP POLICY IF EXISTS "inventory_templates_insert"                      ON public.inventory_templates;
DROP POLICY IF EXISTS "inventory_templates_update"                      ON public.inventory_templates;
DROP POLICY IF EXISTS "inventory_templates_delete"                      ON public.inventory_templates;
DROP POLICY IF EXISTS "inventory_template_items_write"                  ON public.inventory_template_items;
DROP POLICY IF EXISTS "inventory_template_items_select"                 ON public.inventory_template_items;
DROP POLICY IF EXISTS "inventory_template_items_insert"                 ON public.inventory_template_items;
DROP POLICY IF EXISTS "inventory_template_items_update"                 ON public.inventory_template_items;
DROP POLICY IF EXISTS "inventory_template_items_delete"                 ON public.inventory_template_items;

REVOKE ALL ON public.inventory_templates FROM anon;
REVOKE ALL ON public.inventory_template_items FROM anon;

CREATE POLICY "inventory_templates_select"
  ON public.inventory_templates FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "inventory_templates_manage"
  ON public.inventory_templates FOR ALL
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role]));

CREATE POLICY "inventory_template_items_select"
  ON public.inventory_template_items FOR SELECT
  USING (
    template_id IN (
      SELECT id FROM public.inventory_templates WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

CREATE POLICY "inventory_template_items_manage"
  ON public.inventory_template_items FOR ALL
  USING (
    template_id IN (
      SELECT id FROM public.inventory_templates
      WHERE is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
    )
  )
  WITH CHECK (
    template_id IN (
      SELECT id FROM public.inventory_templates
      WHERE is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
    )
  );


-- ── 5. room_templates: mark and protect platform-seeded rows ───────────────
-- Named is_system to match the identical, pre-existing convention on
-- maintenance_schedule_templates ("true = FieldStay seed template") rather
-- than inventing a new name — see self-audit item 5.
--
-- The backfill below is provably correct, not a guess: room_templates
-- already carries UNIQUE (org_id, name) (20260717120000_room_templates.sql).
-- Within one org, a row whose name matches a platform_seed_room_templates
-- name MUST be the seeded row — a PM's own custom template could never have
-- been saved under that same name in that same org in the first place.

ALTER TABLE public.room_templates
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

UPDATE public.room_templates rt
SET is_system = true
WHERE rt.name IN (SELECT name FROM public.platform_seed_room_templates)
  AND rt.is_system = false;

-- Trigger, not just a policy — see self-audit item 4. Without this, an
-- admin could UPDATE is_system to false on a seeded row, then DELETE it,
-- completely bypassing the policy below. This silently reverts any attempt
-- to change is_system through a normal write, regardless of caller's role.

CREATE OR REPLACE FUNCTION public.prevent_room_template_is_system_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    NEW.is_system := OLD.is_system;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE TRIGGER room_templates_protect_is_system
  BEFORE UPDATE ON public.room_templates
  FOR EACH ROW EXECUTE FUNCTION public.prevent_room_template_is_system_change();

-- CORRECTION made during Pass 1 implementation: the doc's draft assumed
-- room_templates still had a single "room_templates_manage" ALL policy to
-- split into insert/update/delete. Live-schema verification shows
-- 20260720122846_split_manage_policies_reduce_permissive_overlap.sql
-- already did that split one day before this pass, and the resulting
-- room_templates_insert / room_templates_update policies already gate on
-- exactly the admin/manager/owner array this migration wants — so they're
-- left untouched below rather than dropped and recreated with an identical
-- definition. room_templates_manage no longer exists to drop (IF EXISTS
-- makes that safe either way). The one policy that actually needs to
-- change is room_templates_delete: today it has no is_system awareness at
-- all, which is exactly the bypass self-audit item 4 above describes —
-- dropping and recreating it with the is_system = false guard is the real
-- functional change this section makes.

DROP POLICY IF EXISTS "room_templates_manage" ON public.room_templates;
DROP POLICY IF EXISTS "room_templates_delete" ON public.room_templates;

-- room_templates_insert / room_templates_update are untouched — already
-- correct (admin/manager/owner gate), no change needed. "Content edits
-- stay allowed on seeded rows" is enforced by room_templates_update having
-- no is_system condition — "editable, never deletable" per the product
-- decision, deliberately not the fully-locked shape maintenance's existing
-- is_system rows currently have.

-- The actual guard.
CREATE POLICY "room_templates_delete"
  ON public.room_templates FOR DELETE
  USING (
    is_system = false
    AND is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role, 'owner'::member_role])
  );

-- room_templates_select is untouched — already correct, no change needed.
