-- Inspections & Audits — PHASE 1: schema and immutability.
--
-- Five tables, the completion lock, and the retention exclusion. No UI, no
-- seed, no remediation — those are phases 2–4. See docs/INSPECTIONS_SPEC.md.
--
-- The two things this migration exists to get right, because neither can be
-- retrofitted safely:
--
--   1. IMMUTABILITY. §1 of the spec: the record is evidence for an insurance
--      discount, which is a higher bar than an owner-facing PDF. A completed
--      inspection that can still be edited is not evidence, and "we hid the
--      button" is not enforcement. Triggers, not UI.
--
--   2. RETENTION EXCLUSION. Five retention crons already sweep this database
--      and none touches inspections today. A future sweep silently deleting
--      insurance evidence is unrecoverable, and this codebase has shipped
--      exactly that shape of bug before (an empty API response deactivating an
--      org's entire crew roster in one microsecond). Excluded on day one, with
--      a guardrail, per the spec.

-- ── Enums ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE inspection_result AS ENUM ('pass', 'fail', 'na');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE inspection_response_type AS ENUM ('yes_no', 'count', 'date', 'text', 'photo');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 'notify' is the value Outdoor's HOA section and Safety's permits section
-- forced: a lapsed short-term-rental permit or unpaid HOA dues is neither a
-- work order nor a purchase order, and pushing one onto the maintenance board
-- would put a finance task on a vendor's queue. It raises a notifications row
-- instead — that table already carries severity and dedupe_key, so a quarterly
-- re-flag of the same unresolved item does not stack.
DO $$ BEGIN
  CREATE TYPE inspection_remediation AS ENUM ('none', 'work_order', 'purchase_order', 'notify');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- What the inspector picks on a fail. MULTI-SELECT: a water heater at end of
-- life is 'replace' AND 'service' — the purchase and the install — which is the
-- "needs both" case the spec's open question 1 could not otherwise express.
-- Cleaning is deliberately NOT here; it is a separate boolean because it
-- aggregates into one crew job rather than producing a record per item.
DO $$ BEGIN
  CREATE TYPE inspection_action AS ENUM ('repair', 'service', 'replace');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Form definition — PLATFORM-owned, no org_id ─────────────────────────────
-- Orgs cannot edit these. There is no per-org copy and no Templates Hub entry;
-- the only author is us.

CREATE TABLE IF NOT EXISTS public.inspection_forms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,                    -- 'safety' | 'indoor' | 'outdoor'
  name        text NOT NULL,
  description text,
  version     integer NOT NULL DEFAULT 1,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Re-seeding upserts on (key, version): shipping a reworded item is a NEW
  -- version, never an edit of the row a completed inspection points at.
  CONSTRAINT inspection_forms_key_version_unique UNIQUE (key, version)
);

CREATE TABLE IF NOT EXISTS public.inspection_form_sections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id    uuid NOT NULL REFERENCES public.inspection_forms(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inspection_form_sections_form_key_unique UNIQUE (form_id, key)
);

CREATE TABLE IF NOT EXISTS public.inspection_form_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id  uuid NOT NULL REFERENCES public.inspection_form_sections(id) ON DELETE CASCADE,
  -- STABLE identity across re-seeds: 'safety.fire.smoke_present'. The row id
  -- changes when a form is re-seeded; this does not, which is why remediation
  -- and the repeat-visit lookup key on it rather than on id.
  key         text NOT NULL,
  prompt      text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,

  response_type   inspection_response_type NOT NULL DEFAULT 'yes_no',
  is_required     boolean NOT NULL DEFAULT true,
  photo_required  boolean NOT NULL DEFAULT false,

  -- Conditional child: shown only when the parent answers <show_when>.
  -- "Smoke detectors present? [Y/N] -> if no, which room?" is two questions
  -- where the second exists only because the first failed. Structured rather
  -- than a free-text note, so the work order can say "install smoke detector —
  -- upstairs hallway" instead of pasting a sentence someone has to read.
  parent_item_id  uuid REFERENCES public.inspection_form_items(id) ON DELETE CASCADE,
  show_when       inspection_result,

  -- Render one row per unit counted at that item (N extinguishers -> N groups
  -- of location/charged/expiry/photo). Beats a fixed cap, which is wrong in
  -- both directions: wasted rows at most properties, a silently lost fourth
  -- extinguisher at a large one.
  repeat_source_item_id uuid REFERENCES public.inspection_form_items(id) ON DELETE SET NULL,

  -- Render one row per ACTIVE property_assets row of this type. Three HVAC
  -- units render three rows; no generator renders no generator question.
  repeat_per_asset boolean NOT NULL DEFAULT false,

  na_reason_template text,
  -- Verify an N/A claim against the asset ledger. "N/A — no pool here" is
  -- exactly the assertion an insurer is entitled to doubt, because the person
  -- who benefits from skipping the pool section is the one making it.
  na_asset_type      asset_type,
  -- Attribute this answer to a property_assets row, so a failure can move the
  -- asset's health_score rather than sitting beside it.
  asset_type         asset_type,

  -- Same physical concern ACROSS forms (and, for well short-cycling, across
  -- items within one form). Safety runs 1-2x/year and Indoor/Outdoor quarterly,
  -- so detectors are deliberately asked on all of them — this is what stops
  -- three questions about one dead detector becoming three work orders.
  -- NARROWER than asset_type on purpose: a due HVAC filter and a fouled
  -- condenser are the same asset and two different jobs.
  concern_key text,

  -- The PRE-SELECTED action, not a constraint. The inspector picks and can
  -- override; this carries our judgment about what an item usually means so the
  -- common case is one tap.
  remediation inspection_remediation NOT NULL DEFAULT 'work_order',
  wo_category wo_category,
  wo_priority priority_level,
  po_catalog_item_id uuid REFERENCES public.inventory_catalog(id) ON DELETE SET NULL,
  po_default_qty     numeric(12,2),

  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inspection_form_items_section_key_unique UNIQUE (section_id, key)
);

-- ── Performances of a form ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inspections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id)    ON DELETE CASCADE,

  form_id      uuid NOT NULL REFERENCES public.inspection_forms(id) ON DELETE RESTRICT,
  form_version integer NOT NULL,
  -- The form AS IT WAS. Re-seeding must not retroactively change what a
  -- completed inspection says it asked: a reworded item shipping in March
  -- cannot be allowed to rewrite what January's report claims.
  form_snapshot  jsonb NOT NULL,
  -- The LETTERHEAD as it was — property name and address, management company,
  -- org owner, and the weather at start. Every one of those is derived from a
  -- live row that can change, and an ownership transfer silently rewriting the
  -- letterhead on three years of past reports would mean the document no longer
  -- says what it said.
  header_snapshot jsonb,

  assigned_to_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Who PHYSICALLY walked the property, typed at sign-off. Free text on
  -- purpose: whoever the PM hands the tablet to counts, FieldStay account or
  -- not, so a locked field would be confidently wrong rather than usefully
  -- blank. Distinct from completed_by_user_id, which records whose session
  -- submitted it. The two are allowed to disagree.
  inspector_name text,

  scheduled_for date,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  source_schedule_id uuid REFERENCES public.maintenance_schedules(id) ON DELETE SET NULL,
  -- Corrections are a NEW inspection referencing the original, never an edit.
  corrects_inspection_id uuid REFERENCES public.inspections(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inspection_items (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES public.inspections(id) ON DELETE CASCADE,
  -- Denormalized for RLS: every policy on this table filters org_id directly
  -- rather than joining to inspections on every row read.
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  form_item_id  uuid NOT NULL REFERENCES public.inspection_form_items(id) ON DELETE RESTRICT,
  -- The prompt as asked, frozen. Same reasoning as form_snapshot, at row grain.
  prompt_snapshot text NOT NULL,

  result  inspection_result,
  -- Multi-select. Empty on a pass; non-empty is what generates the records.
  actions inspection_action[] NOT NULL DEFAULT '{}',
  -- Independent of actions: a dirty oven is neither a repair nor a purchase,
  -- and per-item cleaning work orders would be N dispatches for one visit.
  -- Rolls up into ONE crew-assigned cleaning work order at sign-off.
  needs_cleaning boolean NOT NULL DEFAULT false,

  note       text,
  photo_path text,
  -- The ONLY way past a photo_required item without a photo. Free text with no
  -- preset options so it cannot be tapped through: an unenforceable rule
  -- produces a photograph of the floor, which is worse evidence than an honest
  -- "camera failed".
  photo_unavailable_reason text,
  na_reason  text,

  -- Which asset this answer is about, for repeat_per_asset rows and
  -- asset-scoped items.
  asset_id uuid REFERENCES public.property_assets(id) ON DELETE SET NULL,
  -- Which repeat instance this is (1..N), for repeat_source_item_id groups.
  repeat_index integer,

  answered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- SINGLE-COLUMN primary key, deliberately. A composite PK over two FKs to
  -- different tables reads to PostgREST as a many-to-many JUNCTION, at which
  -- point it starts offering a second embed path between those parents and
  -- every pre-existing `.select('*, parent(...)')` between them breaks with
  -- PGRST201. That shipped on 2026-08-10 and broke four call sites. A UNIQUE on
  -- the same pair is fine — the detection keys on the PRIMARY KEY.
  CONSTRAINT inspection_items_pkey PRIMARY KEY (id),
  CONSTRAINT inspection_items_unique_answer
    UNIQUE (inspection_id, form_item_id, repeat_index)
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Every FK column gets a covering index: check-db-invariants enforces it, and
-- an unindexed FK turns a parent delete into a sequential scan of the child.

CREATE INDEX IF NOT EXISTS idx_inspection_form_sections_form  ON public.inspection_form_sections(form_id);
CREATE INDEX IF NOT EXISTS idx_inspection_form_items_section  ON public.inspection_form_items(section_id);
CREATE INDEX IF NOT EXISTS idx_inspection_form_items_parent   ON public.inspection_form_items(parent_item_id);
CREATE INDEX IF NOT EXISTS idx_inspection_form_items_repeat   ON public.inspection_form_items(repeat_source_item_id);
CREATE INDEX IF NOT EXISTS idx_inspection_form_items_po_item  ON public.inspection_form_items(po_catalog_item_id);
CREATE INDEX IF NOT EXISTS idx_inspection_form_items_concern  ON public.inspection_form_items(concern_key) WHERE concern_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inspections_org               ON public.inspections(org_id);
CREATE INDEX IF NOT EXISTS idx_inspections_property          ON public.inspections(property_id);
CREATE INDEX IF NOT EXISTS idx_inspections_form              ON public.inspections(form_id);
CREATE INDEX IF NOT EXISTS idx_inspections_assigned          ON public.inspections(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_inspections_completed_by      ON public.inspections(completed_by_user_id);
CREATE INDEX IF NOT EXISTS idx_inspections_source_schedule   ON public.inspections(source_schedule_id);
CREATE INDEX IF NOT EXISTS idx_inspections_corrects          ON public.inspections(corrects_inspection_id);
-- The dashboard's "last 30 days" section and the overdue nudge both read this.
CREATE INDEX IF NOT EXISTS idx_inspections_org_completed     ON public.inspections(org_id, completed_at DESC);
-- The open-draft lookup: at most one live draft per property per form.
CREATE INDEX IF NOT EXISTS idx_inspections_open_draft
  ON public.inspections(property_id, form_id) WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_inspection_items_inspection   ON public.inspection_items(inspection_id);
CREATE INDEX IF NOT EXISTS idx_inspection_items_org          ON public.inspection_items(org_id);
CREATE INDEX IF NOT EXISTS idx_inspection_items_form_item    ON public.inspection_items(form_item_id);
CREATE INDEX IF NOT EXISTS idx_inspection_items_asset        ON public.inspection_items(asset_id);
-- Repeat-visit dedup reads failures by concern; §6's open-work-order prompt.
CREATE INDEX IF NOT EXISTS idx_inspection_items_failures
  ON public.inspection_items(org_id, form_item_id) WHERE result = 'fail';

-- ── Immutability ────────────────────────────────────────────────────────────
--
-- A completed inspection takes no further UPDATE. Enforced here rather than in
-- RLS because it must hold for the SERVICE ROLE too: RLS is bypassed by the
-- Inngest functions that will generate remediation, and "immutable unless the
-- backend feels otherwise" is not immutability.
--
-- The transition INTO completion is allowed; everything after it is not.

CREATE OR REPLACE FUNCTION public.reject_completed_inspection_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'inspection % is completed and immutable (completed_at %)', OLD.id, OLD.completed_at
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inspections_immutable_after_completion ON public.inspections;
CREATE TRIGGER trg_inspections_immutable_after_completion
  BEFORE UPDATE ON public.inspections
  FOR EACH ROW EXECUTE FUNCTION public.reject_completed_inspection_edit();

CREATE OR REPLACE FUNCTION public.reject_completed_inspection_item_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_completed_at timestamptz;
BEGIN
  SELECT completed_at INTO v_completed_at
  FROM public.inspections
  WHERE id = COALESCE(NEW.inspection_id, OLD.inspection_id);

  IF v_completed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'inspection % is completed; its items are immutable', COALESCE(NEW.inspection_id, OLD.inspection_id)
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- INSERT included: an answer cannot be added to a finished inspection either.
-- DELETE included for the same reason — removing an inconvenient finding after
-- the fact is the exact tampering this table exists to make impossible.
DROP TRIGGER IF EXISTS trg_inspection_items_immutable_after_completion ON public.inspection_items;
CREATE TRIGGER trg_inspection_items_immutable_after_completion
  BEFORE INSERT OR UPDATE OR DELETE ON public.inspection_items
  FOR EACH ROW EXECUTE FUNCTION public.reject_completed_inspection_item_edit();

-- Server-side timestamps only, never client-supplied.
CREATE OR REPLACE FUNCTION public.touch_inspection_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inspections_touch_updated_at ON public.inspections;
CREATE TRIGGER trg_inspections_touch_updated_at
  BEFORE UPDATE ON public.inspections
  FOR EACH ROW EXECUTE FUNCTION public.touch_inspection_updated_at();

DROP TRIGGER IF EXISTS trg_inspection_items_touch_updated_at ON public.inspection_items;
CREATE TRIGGER trg_inspection_items_touch_updated_at
  BEFORE UPDATE ON public.inspection_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_inspection_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.inspection_forms          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspection_form_sections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspection_form_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspections               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspection_items          ENABLE ROW LEVEL SECURITY;

-- Form definitions are platform-owned and world-readable to signed-in users.
-- No write policy at all: the seed runs as service role, and an org editing a
-- form it is supposed to be held to is the thing this design forbids.
DROP POLICY IF EXISTS "inspection_forms_select" ON public.inspection_forms;
CREATE POLICY "inspection_forms_select" ON public.inspection_forms
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "inspection_form_sections_select" ON public.inspection_form_sections;
CREATE POLICY "inspection_form_sections_select" ON public.inspection_form_sections
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "inspection_form_items_select" ON public.inspection_form_items;
CREATE POLICY "inspection_form_items_select" ON public.inspection_form_items
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "inspections_select" ON public.inspections;
CREATE POLICY "inspections_select" ON public.inspections
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

-- Crew are explicitly excluded — the spec's "PM or a designated team member,
-- NOT crew". 'owner' passes is_org_member unconditionally, which is correct
-- here: a property owner performing their own inspection is a real case.
DROP POLICY IF EXISTS "inspections_manage" ON public.inspections;
CREATE POLICY "inspections_manage" ON public.inspections
  FOR ALL
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

DROP POLICY IF EXISTS "inspection_items_select" ON public.inspection_items;
CREATE POLICY "inspection_items_select" ON public.inspection_items
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "inspection_items_manage" ON public.inspection_items;
CREATE POLICY "inspection_items_manage" ON public.inspection_items
  FOR ALL
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- A GRANT is checked BEFORE RLS and service_role's BYPASSRLS does nothing about
-- a missing one — the 42501 that took vendor auto-assignment down on
-- 2026-08-20. Granted explicitly rather than relying on a default.
GRANT SELECT                         ON public.inspection_forms         TO authenticated;
GRANT SELECT                         ON public.inspection_form_sections TO authenticated;
GRANT SELECT                         ON public.inspection_form_items    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inspections              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inspection_items         TO authenticated;

GRANT ALL ON public.inspection_forms         TO service_role;
GRANT ALL ON public.inspection_form_sections TO service_role;
GRANT ALL ON public.inspection_form_items    TO service_role;
GRANT ALL ON public.inspections              TO service_role;
GRANT ALL ON public.inspection_items         TO service_role;

-- ── Columns the forms forced ────────────────────────────────────────────────

-- Nothing in the schema knew whether a property has an HOA. A name rather than
-- a boolean: it gates Outdoor's HOA section AND prints on the report.
ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS hoa_name text;

-- Remediation creates work orders with this source; the partial unique index
-- that makes generation idempotent lands with phase 4.
ALTER TYPE wo_source ADD VALUE IF NOT EXISTS 'inspection';

-- ── Retention exclusion ─────────────────────────────────────────────────────
--
-- Declared in the database as well as in lib/retention/registry.ts, because
-- the existing retention crons delete through BOTH .from().delete() and
-- SECURITY DEFINER RPCs (purge_expired_audit_events, cleanup_webhook_dedup,
-- cleanup_expired_oauth_states). A code-side guardrail alone would not see a
-- future purge_old_inspections() at all.
--
-- Catalog-only, no DML — safe to point at production.
CREATE OR REPLACE FUNCTION public.retention_protected_table_violations()
RETURNS TABLE (function_name text, protected_table text)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $fn$
  SELECT p.proname::text, t.tbl
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (VALUES
    ('inspections'), ('inspection_items'), ('inspection_forms'),
    ('inspection_form_sections'), ('inspection_form_items')
  ) AS t(tbl)
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND pg_catalog.pg_get_functiondef(p.oid) ~* ('delete\s+from\s+(public\.)?' || t.tbl || '\M')
$fn$;

REVOKE ALL     ON FUNCTION public.retention_protected_table_violations() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.retention_protected_table_violations() TO service_role;

COMMENT ON FUNCTION public.retention_protected_table_violations() IS
  'Catalog-only. Any public function whose body DELETEs from an inspections table. Must always be empty — inspections are insurance evidence and are excluded from every retention sweep.';

COMMENT ON TABLE public.inspections IS
  'RETENTION-EXCLUDED. Insurance evidence; a completed row is immutable and must never be swept. See lib/retention/registry.ts and unit/guardrails/inspections-retention-exclusion.test.ts.';
COMMENT ON TABLE public.inspection_items IS
  'RETENTION-EXCLUDED. See inspections.';
