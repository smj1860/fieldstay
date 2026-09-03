-- ============================================================================
-- Per-property sponsor assignment
--
-- Sponsors stay ORG-level: one guidebook_sponsors row, one $15/mo Stripe
-- subscription, one media kit. This join table decides which PROPERTIES each
-- sponsor appears on. Up to 4 sponsors per property (enforced in the resolver,
-- not here — see lib/guidebook/resolve-property-sponsors.ts).
--
-- "No assignment rows for this property" means AUTOMATIC, which is what gives
-- every existing org a free pass: nothing is backfilled, and an org that never
-- touches this feature keeps exactly today's behaviour.
--
-- properties.sponsor_assignment_mode is what makes "the manager cleared every
-- sponsor off this cabin" distinguishable from "the manager has not chosen
-- yet". Without it, zero rows is ambiguous and the automatic resolver would
-- silently reinstate everything the manager just removed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.guidebook_sponsor_assignments (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Denormalised deliberately: this is what RLS filters on. Reaching org_id by
  -- joining through guidebook_sponsors inside a policy turns every guest page
  -- load into a correlated subquery. It is NEVER supplied by the caller — the
  -- BEFORE trigger below derives it from the sponsor, so a mismatched org_id
  -- (a cross-tenant leak) is not merely rejected, it is unrepresentable.
  org_id      uuid        NOT NULL REFERENCES public.organizations(id)      ON DELETE CASCADE,

  sponsor_id  uuid        NOT NULL REFERENCES public.guidebook_sponsors(id) ON DELETE CASCADE,
  property_id uuid        NOT NULL REFERENCES public.properties(id)         ON DELETE CASCADE,

  -- Denormalised from guidebook_sponsors.slot_type, also trigger-maintained.
  --
  -- WHY DENORMALISED, of the two options: the category-collision rule below has
  -- to be enforced in the DATABASE, and slot_type lives on the sponsor rather
  -- than on this row, so a plain unique constraint cannot see it. The
  -- alternative — a BEFORE trigger that reads the sponsor's type and raises on
  -- collision — needs no duplication but serialises every write against the
  -- same property. A partial unique index does not, and the sync risk is small
  -- because slot_type changes rarely (and the propagation trigger below closes
  -- it when it does).
  slot_type   text        NOT NULL CHECK (
                slot_type IN (
                  'morning_brew',
                  'dinner_pints',
                  'rainy_day',
                  'outdoor_adventure',
                  'general',
                  'other'
                )
              ),

  created_at  timestamptz NOT NULL DEFAULT now(),

  -- One row per sponsor per property. Note this is a UNIQUE and NOT the
  -- primary key: a PRIMARY KEY (sponsor_id, property_id) would read to
  -- PostgREST as a many-to-many junction and start offering a second embed
  -- path between guidebook_sponsors and properties, breaking every
  -- pre-existing `.select('*, parent(...)')` between them with PGRST201.
  -- See CLAUDE.md — this shipped once already, on 2026-08-10.
  CONSTRAINT guidebook_sponsor_assignments_sponsor_property_unique
    UNIQUE (sponsor_id, property_id)
);

-- ── The category-collision constraint ───────────────────────────────────────
--
-- A property must not carry two sponsors of the same NAMED slot type. The
-- media kit promises "exactly one place for coffee"; two morning_brew sponsors
-- on one property means the resolver picks one and the other paid $15/mo for a
-- placement no guest will ever see.
--
-- 'general' and 'other' are exempt — they are the escape hatch for a good local
-- business that does not fit a named category, and a property may carry
-- several.
--
-- Enforced HERE rather than only in the server action because a UI-only rule
-- does not survive the first bulk-assign path someone adds later, and this rule
-- is what keeps a sales claim true.
CREATE UNIQUE INDEX IF NOT EXISTS guidebook_sponsor_assignments_named_slot_unique
  ON public.guidebook_sponsor_assignments (property_id, slot_type)
  WHERE slot_type NOT IN ('general', 'other');

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Every FK column gets a covering index (scripts/check-db-invariants.mjs
-- check 4). property_id needs its own non-partial index: the partial unique
-- above does not cover a lookup for a 'general' assignment.
CREATE INDEX IF NOT EXISTS guidebook_sponsor_assignments_property_id_idx
  ON public.guidebook_sponsor_assignments (property_id);

CREATE INDEX IF NOT EXISTS guidebook_sponsor_assignments_sponsor_id_idx
  ON public.guidebook_sponsor_assignments (sponsor_id);

CREATE INDEX IF NOT EXISTS guidebook_sponsor_assignments_org_id_idx
  ON public.guidebook_sponsor_assignments (org_id);

-- ── org_id / slot_type are DERIVED, never supplied ──────────────────────────
--
-- Both denormalised columns are filled in from the sponsor row on every insert
-- and update. Two things follow, and both are the point:
--
--   * A caller cannot write a row whose org_id disagrees with its sponsor's.
--     That disagreement is exactly the cross-tenant leak this table could
--     otherwise introduce, since org_id is what RLS filters on.
--   * A caller cannot write a slot_type that disagrees with its sponsor's, so
--     the collision index above is always judging the real category.
--
-- SECURITY INVOKER, so the lookups run under the caller's RLS. For a member of
-- the org both rows are visible; for anyone else the SELECT finds nothing and
-- the insert is refused rather than silently mis-scoped. That is defence in
-- depth on top of the explicit org comparison, not a replacement for it.
CREATE OR REPLACE FUNCTION public.guidebook_sponsor_assignment_derive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_sponsor_org  uuid;
  v_sponsor_slot text;
  v_property_org uuid;
BEGIN
  SELECT org_id, slot_type
    INTO v_sponsor_org, v_sponsor_slot
    FROM public.guidebook_sponsors
   WHERE id = NEW.sponsor_id;

  IF v_sponsor_org IS NULL THEN
    RAISE EXCEPTION 'guidebook_sponsor_assignments: sponsor % not found or not visible', NEW.sponsor_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT org_id
    INTO v_property_org
    FROM public.properties
   WHERE id = NEW.property_id;

  IF v_property_org IS NULL THEN
    RAISE EXCEPTION 'guidebook_sponsor_assignments: property % not found or not visible', NEW.property_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_sponsor_org <> v_property_org THEN
    RAISE EXCEPTION 'guidebook_sponsor_assignments: sponsor % (org %) cannot be assigned to property % (org %)',
      NEW.sponsor_id, v_sponsor_org, NEW.property_id, v_property_org
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.org_id    := v_sponsor_org;
  NEW.slot_type := v_sponsor_slot;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guidebook_sponsor_assignment_derive_trg
  ON public.guidebook_sponsor_assignments;

CREATE TRIGGER guidebook_sponsor_assignment_derive_trg
  BEFORE INSERT OR UPDATE ON public.guidebook_sponsor_assignments
  FOR EACH ROW EXECUTE FUNCTION public.guidebook_sponsor_assignment_derive();

-- ── Keep the denormalised slot_type in sync ─────────────────────────────────
--
-- This is the cost of denormalising, paid once here. Editing a sponsor's
-- slot_type rewrites its assignment rows, which re-runs the derive trigger
-- above and re-checks the collision index.
--
-- A sponsor edit that would put two of the same named category on one property
-- therefore FAILS with 23505 rather than silently creating the duplicate
-- placement the index exists to prevent. That is the correct outcome — the
-- manager has to free the category on those properties first — but it does mean
-- a sponsor edit can be rejected for a reason that is about a different table,
-- so the server action translates it (see updateSponsorAction).
CREATE OR REPLACE FUNCTION public.guidebook_sponsor_propagate_slot_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.slot_type IS DISTINCT FROM OLD.slot_type THEN
    UPDATE public.guidebook_sponsor_assignments
       SET slot_type = NEW.slot_type
     WHERE sponsor_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guidebook_sponsor_propagate_slot_type_trg
  ON public.guidebook_sponsors;

CREATE TRIGGER guidebook_sponsor_propagate_slot_type_trg
  AFTER UPDATE OF slot_type ON public.guidebook_sponsors
  FOR EACH ROW EXECUTE FUNCTION public.guidebook_sponsor_propagate_slot_type();

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.guidebook_sponsor_assignments ENABLE ROW LEVEL SECURITY;

-- The GRANT is a separate prerequisite RLS depends on but does not replace:
-- Postgres checks it BEFORE any policy is evaluated, so a table with perfect
-- policies and no grant throws "permission denied" on every query.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.guidebook_sponsor_assignments TO authenticated;

DROP POLICY IF EXISTS "guidebook_sponsor_assignments_select" ON public.guidebook_sponsor_assignments;
DROP POLICY IF EXISTS "guidebook_sponsor_assignments_manage" ON public.guidebook_sponsor_assignments;

CREATE POLICY "guidebook_sponsor_assignments_select"
  ON public.guidebook_sponsor_assignments FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "guidebook_sponsor_assignments_manage"
  ON public.guidebook_sponsor_assignments FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── The manual/auto marker ──────────────────────────────────────────────────
--
-- Set to 'manual' the first time a manager edits a property's assignments,
-- INCLUDING when they clear them all. Automatic never overwrites a manual
-- property; "reset to automatic" in the UI sets it back to 'auto' and deletes
-- that property's rows.
--
-- DEFAULT 'auto' is what makes this migration a no-op for every existing row:
-- nothing to backfill, and an org that never opens the feature is unaffected.
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS sponsor_assignment_mode text NOT NULL DEFAULT 'auto';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.properties'::regclass
       AND conname  = 'properties_sponsor_assignment_mode_check'
  ) THEN
    ALTER TABLE public.properties
      ADD CONSTRAINT properties_sponsor_assignment_mode_check
      CHECK (sponsor_assignment_mode IN ('auto', 'manual'));
  END IF;
END
$$;
