-- Dynamic PAR engine, pass 1 — configuration columns across the catalog →
-- template → property-item chain, plus the consumption-stats table the
-- historical engine (pass 2) will populate.
--
-- Design (see lib/inventory/par-engine.ts):
--   par_mode 'static' — par_level is a manually-set integer; the engine never
--     touches it. This is the default, so every existing row behaves exactly
--     as it does today.
--   par_mode 'smart'  — par_level becomes a server-maintained CACHE. The
--     resolver computes it from the row's smart_group + base_qty against the
--     property's bedrooms/bathrooms/max_guests, or from historical
--     consumption once enough samples exist. Multipliers and buffers live in
--     code (PAR_SMART_GROUPS in lib/inventory/par-engine.ts), NOT in the
--     database, so tuning a global default never needs a data migration —
--     just a recompute broadcast.

-- ── Enums ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE par_mode AS ENUM ('static', 'smart');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE par_smart_group AS ENUM (
    'bathroom_essential',   -- scales with properties.bathrooms
    'bedroom_essential',    -- scales with properties.bedrooms
    'guest_consumable'      -- scales with properties.max_guests
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Platform master catalog (admin panel: /admin/inventory-catalog) ─────────
-- base_qty is the per-unit-of-multiplier baseline (e.g. 2 rolls PER bathroom).
-- default_par_level (existing) remains the static fallback / pre-fill.

ALTER TABLE public.inventory_catalog
  ADD COLUMN IF NOT EXISTS par_mode    par_mode NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS smart_group par_smart_group,
  ADD COLUMN IF NOT EXISTS base_qty    numeric NOT NULL DEFAULT 1 CHECK (base_qty > 0);

-- A smart row must say which group it scales by; a static row must not carry
-- a stale group. Enforced at the catalog roots so bad config can't propagate.
DO $$ BEGIN
  ALTER TABLE public.inventory_catalog
    ADD CONSTRAINT inventory_catalog_smart_group_matches_mode
    CHECK ((par_mode = 'smart') = (smart_group IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Org's editable catalog copy (Templates Hub master list) ─────────────────

ALTER TABLE public.org_inventory_catalog
  ADD COLUMN IF NOT EXISTS par_mode    par_mode NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS smart_group par_smart_group,
  ADD COLUMN IF NOT EXISTS base_qty    numeric NOT NULL DEFAULT 1 CHECK (base_qty > 0);

DO $$ BEGIN
  ALTER TABLE public.org_inventory_catalog
    ADD CONSTRAINT org_inventory_catalog_smart_group_matches_mode
    CHECK ((par_mode = 'smart') = (smart_group IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Platform inventory templates (admin panel: /admin/inventory-templates) ──
-- Carried per template item so the admin can override the catalog default per
-- template (e.g. the same "Bath Towels" item static in a budget template but
-- smart/guest_consumable in the standard template).

ALTER TABLE public.platform_inventory_template_items
  ADD COLUMN IF NOT EXISTS par_mode    par_mode NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS smart_group par_smart_group,
  ADD COLUMN IF NOT EXISTS base_qty    numeric NOT NULL DEFAULT 1 CHECK (base_qty > 0);

DO $$ BEGIN
  ALTER TABLE public.platform_inventory_template_items
    ADD CONSTRAINT platform_inv_tpl_items_smart_group_matches_mode
    CHECK ((par_mode = 'smart') = (smart_group IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Org inventory templates ─────────────────────────────────────────────────

ALTER TABLE public.inventory_template_items
  ADD COLUMN IF NOT EXISTS par_mode    par_mode NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS smart_group par_smart_group,
  ADD COLUMN IF NOT EXISTS base_qty    numeric NOT NULL DEFAULT 1 CHECK (base_qty > 0);

DO $$ BEGIN
  ALTER TABLE public.inventory_template_items
    ADD CONSTRAINT inventory_template_items_smart_group_matches_mode
    CHECK ((par_mode = 'smart') = (smart_group IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Property-level items ────────────────────────────────────────────────────
-- par_level (existing) becomes the resolved CACHE when par_mode = 'smart'.
-- auto_adjust=false lets a PM keep smart-formula behavior but pin the item
-- against historical overrides. par_resolved_at is observability only.

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS par_mode        par_mode NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS smart_group     par_smart_group,
  ADD COLUMN IF NOT EXISTS base_qty        numeric NOT NULL DEFAULT 1 CHECK (base_qty > 0),
  ADD COLUMN IF NOT EXISTS auto_adjust     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS par_resolved_at timestamptz;

DO $$ BEGIN
  ALTER TABLE public.inventory_items
    ADD CONSTRAINT inventory_items_smart_group_matches_mode
    CHECK ((par_mode = 'smart') = (smart_group IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Consumption stats (populated by pass 2's Inngest work) ──────────────────
-- One rolling aggregate per (property, item). Rows are written exclusively by
-- the service role inside Inngest steps; org members get read-only access so
-- the par-levels UI can explain WHY a smart par is what it is.

CREATE TABLE IF NOT EXISTS public.inventory_consumption_stats (
  property_id             uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  inventory_item_id       uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  org_id                  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  avg_rate_per_guest_night numeric NOT NULL DEFAULT 0 CHECK (avg_rate_per_guest_night >= 0),
  sample_count            integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  last_sample_at          timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, inventory_item_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_consumption_stats_org_id
  ON public.inventory_consumption_stats (org_id);

-- inventory_item_id is an FK but only the SECOND column of the primary key, so
-- the PK's index does not cover it — a lookup or an ON DELETE CASCADE from
-- inventory_items would seq-scan. scripts/check-db-invariants.mjs fails on any
-- FK column without a covering index; property_id is covered as the PK's
-- leading column and org_id by the index above, this one was the gap.
CREATE INDEX IF NOT EXISTS idx_inventory_consumption_stats_item_id
  ON public.inventory_consumption_stats (inventory_item_id);

CREATE OR REPLACE TRIGGER inventory_consumption_stats_updated_at
  BEFORE UPDATE ON public.inventory_consumption_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.inventory_consumption_stats ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.inventory_consumption_stats TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_consumption_stats TO service_role;

-- Read-only for org members. No INSERT/UPDATE/DELETE policies for
-- authenticated at all — writes go through service-role Inngest steps only.
-- get_user_org_ids(), not a hand-rolled organization_members subquery: the
-- helper is the one place the membership rule lives (it also requires
-- invite_accepted_at IS NOT NULL, which the raw subquery this replaced did
-- not, so that version would have shown stats to members with a pending
-- invite). CLAUDE.md → Critical Security Rules #2.
DROP POLICY IF EXISTS "inventory_consumption_stats_select" ON public.inventory_consumption_stats;
CREATE POLICY "inventory_consumption_stats_select"
  ON public.inventory_consumption_stats FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));
