-- Scheduling an inspection: maintenance_schedules gains a discriminator.
--
-- INSPECTIONS_SPEC §7. Three columns, and the reason it is only three is the
-- point of the section: "The timing rule — when is this due, does it fall
-- inside the seasonal window, how does next_due_date advance — must not exist
-- twice. The output differs; the timing logic does not."
--
-- `schedule_frequency` already carries quarterly | semi_annual | annual, which
-- covers all three inspection forms exactly. `active_from_month` /
-- `active_to_month` already express the seasonal window. `calcNextDueDate`
-- already rolls the date forward. None of that is duplicated here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THE SPEC ASKED FOR AND THIS DELIBERATELY OMITS
--
-- §7 also proposed `anchor_months smallint[]` — "the single starting month" a
-- recurrence derives from. It is not stored, because it is not a fact: it is a
-- restatement of where `next_due_date` already sits.
--
-- The advance is anchored on next_due_date itself (see
-- complete-work-order-helpers.ts: "Normal on-time completions keep the existing
-- fixed-calendar anchor"), and calcNextDueDate steps +3 / +6 / +12 months from
-- it. Quarterly from 1 March goes Jun → Sep → Dec → Mar, forever. The anchor
-- month is EMERGENT from (next_due_date, frequency), including the semi-annual
-- case the array was meant to serve: two anchor months are one start date and a
-- +6 step, not two stored values.
--
-- Storing it would mean two columns that must agree about the same thing, and
-- the one the advance does not read is the one that silently rots. The table
-- already demonstrates this: `month_due` is exactly that column, wired end to
-- end and set on 0 of 145 live rows. It should be removed separately.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A DUE INSPECTION SCHEDULE DOES NOT PRE-CREATE AN INSPECTION
--
-- The work-order path creates its row when the schedule comes due. The
-- inspection path cannot, and the reason is `inspections.started_at`, which is
-- NOT NULL DEFAULT now(). A row minted by the 08:00 cron would claim the walk
-- began at 08:00 — so every scheduled inspection would carry a duration
-- measured from a cron run rather than from someone arriving at the property,
-- and §12.3's report presents that duration as evidence.
--
-- It would also put a walk nobody has started onto every tablet: the warm pass
-- caches OPEN inspections, and an inspection is open from the moment it exists.
--
-- So a due inspection schedule NOTIFIES, and the row is created when the walk
-- actually begins — which is the path that already exists and already stamps a
-- real start time. `inspections.source_schedule_id` (phase 1, unused until now)
-- is what links the two, and completion is what advances the schedule. That
-- matches how `auto_create_wo = false` reminder schedules already behave: they
-- deliberately do not roll forward on the due date, because nothing acted on
-- them yet.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schedule_creates') THEN
    CREATE TYPE schedule_creates AS ENUM ('work_order', 'inspection');
  END IF;
END $$;

ALTER TABLE maintenance_schedules
  ADD COLUMN IF NOT EXISTS creates schedule_creates NOT NULL DEFAULT 'work_order',

  -- ON DELETE RESTRICT, not SET NULL. Retiring a form is `is_active = false`
  -- (the seed is upsert-only and never deletes), so this never fires in normal
  -- operation — and if someone does try to delete a form that schedules point
  -- at, failing loudly beats silently orphaning them.
  --
  -- RESTRICT also keeps the CHECK below safe. A SET NULL cascade would produce
  -- exactly the state the CHECK forbids and abort the delete instead, which is
  -- the interlock that had to be unpicked in 20260823180811.
  ADD COLUMN IF NOT EXISTS inspection_form_id uuid
    REFERENCES inspection_forms(id) ON DELETE RESTRICT,

  -- Genuinely new, per §7: nothing in the app assigns work to an ORG MEMBER.
  -- Everything assigns to crew (assigned_crew_member_id) or resolves the
  -- primary admin via getOrgDispatcher. An inspection is walked by a PM.
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid
    REFERENCES auth.users(id) ON DELETE SET NULL;

-- The FK-covering-index invariant in scripts/check-db-invariants.mjs wants one
-- on every reference column. Partial: the overwhelming majority of schedules
-- are work orders with neither set.
CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_inspection_form
  ON maintenance_schedules (inspection_form_id)
  WHERE inspection_form_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_maintenance_schedules_assigned_to_user
  ON maintenance_schedules (assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;

-- An inspection schedule with no form cannot produce anything: the due pass
-- would have nothing to tell the PM to walk. Enforced in the database rather
-- than only in the action, because the seed and the dashboard both write here.
ALTER TABLE maintenance_schedules
  DROP CONSTRAINT IF EXISTS maintenance_schedules_inspection_needs_form;
ALTER TABLE maintenance_schedules
  ADD CONSTRAINT maintenance_schedules_inspection_needs_form
  CHECK (creates <> 'inspection' OR inspection_form_id IS NOT NULL);

COMMENT ON COLUMN maintenance_schedules.creates IS
  'What this schedule produces when it comes due. A work_order schedule creates one; an inspection schedule NOTIFIES and the row is created when the walk begins, because inspections.started_at must be a real start time.';
COMMENT ON COLUMN maintenance_schedules.inspection_form_id IS
  'Which inspection form to walk. Required when creates = inspection.';
COMMENT ON COLUMN maintenance_schedules.assigned_to_user_id IS
  'The org member expected to walk this. Distinct from assigned_crew_member_id, which is a crew_members row — nothing else in the app assigns to an org member.';
