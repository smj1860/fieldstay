-- Stages a checkout/checkin date change against an in_progress turnover
-- instead of silently overwriting checkout_datetime/checkin_datetime out
-- from under a crew member mid-clean. Populated by
-- lib/turnovers/generator.ts's refreshExistingPairDates() when a booking's
-- dates change after its turnover pair already exists; acknowledged (but
-- NOT applied) by a crew member via lib/dexie/helpers.ts
-- acknowledgeDatesChanged(). See CLAUDE_HOSPITABLE_DEXIE_AUDIT_FIXES_1.md
-- Task 3 for the full design rationale.
ALTER TABLE turnovers
  ADD COLUMN IF NOT EXISTS pending_checkout_datetime     timestamptz,
  ADD COLUMN IF NOT EXISTS pending_checkin_datetime      timestamptz,
  ADD COLUMN IF NOT EXISTS dates_changed_at              timestamptz,
  ADD COLUMN IF NOT EXISTS dates_change_acknowledged_at  timestamptz;

COMMENT ON COLUMN turnovers.dates_changed_at IS
  'Set when generateTurnoversForProperty detects a booking-date change against an in_progress turnover it deliberately did not auto-apply. NULL = no pending change. A newer change re-arms this (and clears dates_change_acknowledged_at) even if a prior change was already acknowledged.';

COMMENT ON COLUMN turnovers.pending_checkout_datetime IS
  'Staged replacement for checkout_datetime, populated only when the turnover was in_progress at the time the underlying booking dates changed. Never auto-applied — a PM must explicitly update checkout_datetime from the dashboard if the change should take effect.';

-- No RLS policy changes needed. turnovers_update (see
-- 20260617060028_consolidate_multiple_permissive_policies.sql) is a
-- table-level, row-scoped policy with no column restriction — a crew
-- member already assigned to the turnover can write
-- dates_change_acknowledged_at the same way they already write
-- inventory_started_at / completion_notes directly from the client.

NOTIFY pgrst, 'reload schema';
