-- Per-property freeze threshold. NULL = platform default
-- (lib/evidence/freeze-watch.ts DEFAULT_FREEZE_THRESHOLD_F). Fahrenheit, to
-- match the imperial units the weather transport already requests.
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS freeze_threshold_f integer;

ALTER TABLE public.properties
  DROP CONSTRAINT IF EXISTS properties_freeze_threshold_f_range;
ALTER TABLE public.properties
  ADD CONSTRAINT properties_freeze_threshold_f_range
    CHECK (freeze_threshold_f IS NULL OR (freeze_threshold_f BETWEEN -20 AND 45));

COMMENT ON COLUMN public.properties.freeze_threshold_f IS
  'Forecast low (F) at or below which Freeze Watch creates a prep work order while the property is vacant. NULL uses the platform default.';

-- One freeze-prep work order per property per forecast date. A retried step
-- collides on this and recovers the winner, same shape as
-- wo_maintenance_schedule_date_unique. Partial, so it cannot be a bulk
-- ON CONFLICT target (42P10); inserts are one row at a time.
CREATE UNIQUE INDEX IF NOT EXISTS wo_freeze_watch_property_date_unique
  ON public.work_orders (property_id, needed_by_date)
  WHERE source = 'freeze_watch';
