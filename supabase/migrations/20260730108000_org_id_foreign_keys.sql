-- Pre-launch audit 2026-07-30 — tables carrying org_id with no FK to
-- organizations. Without the constraint, deleting an organization leaves the
-- rows behind, invisible to RLS and unreachable by any cleanup path (the same
-- orphaning mechanism as blocker B3, one level down).
--
-- Orphan check run read-only against vpmznjktllhmmbfnxuvk on 2026-07-30
-- before writing this migration:
--
--   asset_depreciation_entries      0
--   assignment_outcomes             0
--   crew_availability               0
--   inventory_count_drafts          0
--   messages                        0
--   vendor_assignment_outcomes      0
--   inventory_templates             1   ← handled below
--   maintenance_schedule_templates  1   ← deliberately NOT constrained
--
-- maintenance_schedule_templates is EXCLUDED on purpose. It holds the
-- platform-level seed template 'FieldStay STR Standard'
-- (id ffffffff-…, org_id 00000000-0000-0000-0000-000000000000) inserted by
-- 20260608043808_add_maintenance_schedule_templates.sql:67-68 and still
-- referenced by 18 maintenance_schedule_template_items rows. The sentinel
-- org_id is a deliberate "belongs to no tenant" marker, not drift, and no
-- organizations row exists (or should exist) for it — creating one purely to
-- satisfy a FK would then violate the "every org has at least one member"
-- invariant added in 20260730110000. The table is recorded as a named
-- exception in scripts/check-db-invariants.mjs instead.

-- The single inventory_templates orphan (cc145a87-…, org e6726e05-… which no
-- longer exists) has zero inventory_template_items and is unreachable by RLS
-- from any tenant — it is dead data left by an earlier org removal, and it is
-- the only thing blocking the constraint below.
DELETE FROM public.inventory_templates t
WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.org_id);

ALTER TABLE public.asset_depreciation_entries
  DROP CONSTRAINT IF EXISTS asset_depreciation_entries_org_id_fkey;
ALTER TABLE public.asset_depreciation_entries
  ADD  CONSTRAINT asset_depreciation_entries_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.assignment_outcomes
  DROP CONSTRAINT IF EXISTS assignment_outcomes_org_id_fkey;
ALTER TABLE public.assignment_outcomes
  ADD  CONSTRAINT assignment_outcomes_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.crew_availability
  DROP CONSTRAINT IF EXISTS crew_availability_org_id_fkey;
ALTER TABLE public.crew_availability
  ADD  CONSTRAINT crew_availability_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.inventory_count_drafts
  DROP CONSTRAINT IF EXISTS inventory_count_drafts_org_id_fkey;
ALTER TABLE public.inventory_count_drafts
  ADD  CONSTRAINT inventory_count_drafts_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.inventory_templates
  DROP CONSTRAINT IF EXISTS inventory_templates_org_id_fkey;
ALTER TABLE public.inventory_templates
  ADD  CONSTRAINT inventory_templates_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_org_id_fkey;
ALTER TABLE public.messages
  ADD  CONSTRAINT messages_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.vendor_assignment_outcomes
  DROP CONSTRAINT IF EXISTS vendor_assignment_outcomes_org_id_fkey;
ALTER TABLE public.vendor_assignment_outcomes
  ADD  CONSTRAINT vendor_assignment_outcomes_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Covering indexes for the new FK columns (db-invariants check 3). Only the
-- four that lack one — asset_depreciation_entries (idx_depreciation_org_year),
-- inventory_templates (inventory_templates_org_name_unique) and messages
-- (idx_messages_conversation) already lead with org_id, and a duplicate index
-- is pure write-amplification.
CREATE INDEX IF NOT EXISTS idx_assignment_outcomes_org_id
  ON public.assignment_outcomes (org_id);
CREATE INDEX IF NOT EXISTS idx_crew_availability_org_id
  ON public.crew_availability (org_id);
CREATE INDEX IF NOT EXISTS idx_inventory_count_drafts_org_id
  ON public.inventory_count_drafts (org_id);
CREATE INDEX IF NOT EXISTS idx_vendor_assignment_outcomes_org_id
  ON public.vendor_assignment_outcomes (org_id);
