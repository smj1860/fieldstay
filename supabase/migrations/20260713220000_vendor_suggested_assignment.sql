-- Suggested vendor assignment for work orders — a close port of the
-- suggested crew assignment feature for turnovers, built with the override
-- tracking and closed learning loop that crew's version was originally
-- missing (see 20260713210000_close_crew_suggestion_learning_loop.sql).

-- 1. Suggestion fields on work_orders, mirroring turnovers.suggested_crew_ids
--    / suggestion_reasoning / suggestion_status exactly.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS suggested_vendor_ids UUID[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS suggestion_reasoning TEXT   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS suggestion_status    TEXT   DEFAULT NULL
    CHECK (suggestion_status IN ('pending','accepted','overridden','dismissed') OR suggestion_status IS NULL);

COMMENT ON COLUMN work_orders.suggested_vendor_ids IS
  'Vendor UUID recommended by the auto-assign-vendor Inngest function.
   Populated when organizations.vendor_auto_assign_mode = suggest.';
COMMENT ON COLUMN work_orders.suggestion_status IS
  'pending = suggestion made, awaiting PM action.
   accepted = PM confirmed the suggestion.
   overridden = PM assigned a different vendor.
   dismissed = PM dismissed the suggestion.';

-- 2. Org-level toggle, separate from organizations.auto_assign_mode (crew).
--    Vendor assignment carries more real-world risk (external party, real
--    cost) than crew scheduling, so this defaults to 'disabled' rather than
--    crew's default-on 'suggest', and — unlike crew — has no 'autopilot'
--    value yet; that's a deliberate follow-on decision, not an oversight.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS vendor_auto_assign_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (vendor_auto_assign_mode IN ('suggest', 'disabled'));

-- 3. Vendor suggestion outcome tracking. Much smaller than crew's
--    assignment_outcomes because work_orders already carries vendor_rating,
--    scheduled_date, and completed_date natively — there's no need to
--    shadow-copy was_late/was_missed/pm_rating onto a parallel table the way
--    turnovers required (turnovers had no completion-quality signal at all
--    before that fix). This table only needs the suggestion-specific
--    bookkeeping that work_orders itself has no room for.
CREATE TABLE IF NOT EXISTS vendor_assignment_outcomes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL,
  work_order_id    UUID        NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  vendor_id        UUID        NOT NULL REFERENCES vendors(id)     ON DELETE CASCADE,
  property_id      UUID        REFERENCES properties(id)           ON DELETE SET NULL,
  suggested_score  SMALLINT,            -- 0-100 score the algorithm assigned
  score_breakdown  JSONB,               -- { proximity, familiarity, workload, reliability, complianceFactor }
  was_suggestion   BOOLEAN     NOT NULL DEFAULT false,
  was_accepted     BOOLEAN,             -- NULL = no suggestion existed for this WO
  override_reason  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (work_order_id, vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_assignment_outcomes_vendor
  ON vendor_assignment_outcomes(vendor_id, created_at DESC);

ALTER TABLE vendor_assignment_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vendor_assignment_outcomes_select"
  ON vendor_assignment_outcomes FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "vendor_assignment_outcomes_manage"
  ON vendor_assignment_outcomes FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- 4. vendors.avg_rating/rating_count already exist but are never written by
--    any code — app/(dashboard)/vendors/page.tsx computes the real live
--    average from work_orders.vendor_rating on every page load instead of
--    trusting these columns, while the maintenance-schedule vendor-specialty
--    fallback (lib/inngest/functions/cron/work-order-ops.ts) blindly sorts
--    by the frozen, always-default column. on_time_pct/on_time_sample_size
--    are on the TypeScript Vendor interface already but were never real
--    columns at all — pure schema/type drift. This adds the missing columns;
--    the new vendor-score-recompute cron is what actually keeps all four
--    maintained going forward.
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS on_time_pct         NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS on_time_sample_size INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN vendors.on_time_pct IS
  'Percentage of completed work orders finished on or before scheduled_date,
   out of completed WOs with both scheduled_date and completed_date set.
   Maintained by the nightly vendor-score-recompute cron, once at least 3
   qualifying work orders exist (see on_time_sample_size).';
COMMENT ON COLUMN vendors.on_time_sample_size IS
  'Count of completed work orders factored into on_time_pct.';
