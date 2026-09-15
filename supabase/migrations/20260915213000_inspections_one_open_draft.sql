-- ============================================================================
-- idx_inspections_open_draft's own comment claimed "at most one live draft
-- per property per form", but the index was CREATE INDEX (non-unique), not
-- CREATE UNIQUE INDEX — nothing stopped two concurrent "Start Inspection"
-- actions (two devices, or one device double-tapping before its own cache
-- re-renders) from inserting two open ad-hoc drafts for the same
-- (property_id, form_id). That is a narrower/older cousin of the exact race
-- 20260915122230_inspections_one_open_walk_per_schedule.sql closed for
-- SCHEDULE-linked walks — this is the same defect for ad-hoc ones (no
-- source_schedule_id at all), which that migration's WHERE clause
-- deliberately exempts.
--
-- Verified zero live violations on both projects before adding the
-- constraint (no existing (property_id, form_id) pair currently has two
-- open rows), so this cannot fail on data that already exists.
--
-- UNLIKE the schedule case, a second racer here cannot be safely absorbed by
-- silently dropping a field and re-inserting under the same id — the
-- crew member's answers on the LOSING device are real, distinct work that a
-- silent "already exists, do nothing" would throw away with no trace (the
-- device would believe its sync succeeded while no inspections row for its
-- id ever existed to receive its inspection_items). So the app-side handler
-- (app/api/inspections/route.ts) treats this as a TERMINAL conflict — a 409,
-- not a 500 the outbox retries forever — surfaced through the same
-- dead-letter/retry-banner path every other terminal outbox failure uses,
-- rather than either corrupting data by discarding it or masking the
-- conflict as success.
-- ============================================================================

DROP INDEX IF EXISTS public.idx_inspections_open_draft;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inspections_one_open_draft
  ON public.inspections(property_id, form_id)
  WHERE completed_at IS NULL;
