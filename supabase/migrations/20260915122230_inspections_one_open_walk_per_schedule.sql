-- ============================================================================
-- "At most one open inspection per §7 schedule" was enforced ONLY by a
-- read-time filter (selectUpcomingSchedules / selectDueSchedules in
-- lib/inspections/due-schedules.ts): a schedule already backing an
-- uncompleted inspection is filtered out of the due/upcoming list a PM is
-- shown, so tapping "Start" a second time never appears possible — as long as
-- every device's local cache is already caught up with every other device's
-- in-flight create.
--
-- It is not. Inspections are created client-side (device-generated uuid,
-- lib/dexie/dashboard/start-inspection-local.ts) and synced through an
-- outbox that can lag by however long a tablet is offline. Two crew members
-- on two devices — or the same device racing a double-tap before its own
-- cache re-renders — can each generate a FRESH inspection id against the
-- SAME source_schedule_id, and app/api/inspections/route.ts's upsert only
-- dedups on `id` (ON CONFLICT (id) DO NOTHING), which does nothing for two
-- genuinely different ids. Per due-schedules.ts's own header comment: "two
-- reports, and whichever finishes last advances the schedule while the
-- other is orphaned" — a real, previously unguarded outcome, not a
-- hypothetical one.
--
-- This closes it with a real constraint rather than trusting the read-time
-- filter to always be consulted before every create: at most one row per
-- source_schedule_id may be open (completed_at IS NULL) at a time. NULL
-- source_schedule_id is exempt — every ad-hoc walk (most inspections) has no
-- schedule to collide on, and a plain UNIQUE would treat every ad-hoc walk
-- as colliding with every other.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS inspections_one_open_walk_per_schedule
  ON public.inspections(source_schedule_id)
  WHERE source_schedule_id IS NOT NULL AND completed_at IS NULL;
