-- Split work_orders.scheduled_date into two columns with one meaning each.
--
-- THE DEFECT. One column was read two contradictory ways:
--   * app/(dashboard)/vendors/page.tsx computes vendor on-time % as
--     `completed_date <= scheduled_date` — DEADLINE semantics.
--   * maintenance-calendar.tsx keys the calendar on `scheduled_date === iso`,
--     app/crew/page.tsx splits today/upcoming on it, /ops orders by it, and the
--     vendor dispatch email prints it as when to show up — APPOINTMENT semantics.
--
-- A PM's "I need this done by Friday" and a vendor's "I can come Thursday at 2"
-- are different facts. Storing them in one column means the on-time metric grades
-- the vendor against a date the vendor chose, which is self-grading and worthless.
--
-- WHY ADD RATHER THAN RENAME. `ALTER TABLE ... RENAME COLUMN` would be cleaner
-- naming, but PostgREST select strings are string LITERALS and
-- lib/supabase/server.ts omits the <Database> generic, so no .from() call is
-- type-checked. A rename converts ~40 compile-time-invisible call sites into
-- runtime errors with nothing to catch them first. scheduled_date and
-- scheduled_time therefore stay, stop being written by new code, and are
-- deprecated in place — the same treatment work_orders.assigned_crew_id got.
--
-- See docs/WO_VENDOR_RESPONSE_AND_SCHEDULING_SPEC.md Phase A.

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS needed_by_date          date,
  ADD COLUMN IF NOT EXISTS vendor_scheduled_at     timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_scheduled_window text;

-- The window qualifies vendor_scheduled_at, because trades commit to "Tuesday
-- afternoon", not to 14:15. 'exact' means the timestamp is literal.
--
-- Added separately and idempotently: ADD COLUMN IF NOT EXISTS does not re-run on
-- a second apply, so an inline CHECK would be skipped on a database that already
-- had the column from an out-of-band apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_orders_vendor_scheduled_window_check'
      AND conrelid = 'public.work_orders'::regclass
  ) THEN
    ALTER TABLE public.work_orders
      ADD CONSTRAINT work_orders_vendor_scheduled_window_check
      CHECK (
        vendor_scheduled_window IS NULL
        OR vendor_scheduled_window IN ('morning', 'afternoon', 'evening', 'all_day', 'exact')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.work_orders.needed_by_date IS
  'The date the PM needs the work completed BY. A deadline, never an appointment. '
  'Defaults at create time to the property''s next booking check-in date. '
  'This is what vendor on-time % measures against.';

COMMENT ON COLUMN public.work_orders.vendor_scheduled_at IS
  'When the vendor is actually coming. Written by the VENDOR on accept '
  '(see spec Phase B2 — accepting a work order IS setting this date); a PM may '
  'override. Qualified by vendor_scheduled_window.';

COMMENT ON COLUMN public.work_orders.vendor_scheduled_window IS
  'morning | afternoon | evening | all_day | exact. Qualifies vendor_scheduled_at: '
  'trades commit to a window, not a minute. ''exact'' means the timestamp is literal.';

COMMENT ON COLUMN public.work_orders.scheduled_date IS
  'DEPRECATED 2026-10-11 (20261011120000). Overloaded: read as both a PM deadline '
  'and a vendor appointment. Use needed_by_date or vendor_scheduled_at. Retained '
  'because PostgREST select strings are untyped literals, so a rename would break '
  'call sites at runtime rather than at build time.';

COMMENT ON COLUMN public.work_orders.scheduled_time IS
  'DEPRECATED 2026-10-11 (20261011120000). Use vendor_scheduled_at + '
  'vendor_scheduled_window.';

-- Backfill. Every existing value was AUTHORED as a PM deadline (that is what the
-- create form asked for) even where it was later READ as an appointment, so the
-- deadline column is where it belongs. vendor_scheduled_at is deliberately left
-- NULL: no vendor has ever confirmed an appointment, and inventing one would make
-- every historical work order look confirmed.
UPDATE public.work_orders
SET needed_by_date = scheduled_date
WHERE scheduled_date IS NOT NULL
  AND needed_by_date IS NULL;

-- Both columns are filtered and ordered on (board, calendar, /ops, crew split,
-- the dispatch-silence timer), so neither read may degrade to a sequential scan
-- on a large org. Partial: a work order with no date never participates.
CREATE INDEX IF NOT EXISTS idx_work_orders_needed_by_date
  ON public.work_orders (org_id, needed_by_date)
  WHERE needed_by_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_orders_vendor_scheduled_at
  ON public.work_orders (org_id, vendor_scheduled_at)
  WHERE vendor_scheduled_at IS NOT NULL;
