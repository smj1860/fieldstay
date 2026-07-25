-- Second first-run reconciliation finding from the types/database.ts drift
-- gate (scripts/check-type-drift.mjs), and the more serious of the two:
-- app/(dashboard)/inventory/actions.ts's approveInventoryCount() and
-- rejectInventoryCount() both write
--   .update({ status: ..., reviewed_at: <now>, reviewed_by: user.id })
-- to inventory_count_drafts, but that table has never had reviewed_at or
-- reviewed_by columns on either live project — the table that actually got
-- created was 20260604223326_add_inventory_count_drafts.sql (submitted_by,
-- status, notes only). A later migration
-- (20260609000003/20260609111810_schema_history_gaps.sql) DID define
-- reviewed_at/reviewed_by, but used CREATE TABLE IF NOT EXISTS against a
-- table that already existed by then, so it silently no-opped — the columns
-- were never actually added. Net effect: every PM approve/reject of a
-- pending inventory count throws "Could not find the 'reviewed_at' column"
-- and fails, on both projects, today. Same silent-drift failure mode as the
-- wo_status.quote_requested and crew_feedback.submitted_at incidents, just
-- undiscovered until this check went looking. Add the columns the app
-- already depends on rather than rip out the review audit trail.
ALTER TABLE public.inventory_count_drafts
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Covering index for the new FK, matching this repo's convention for every
-- other *_by/*_user_id → auth.users(id) column (see
-- idx_work_orders_completion_verified_by, idx_work_order_updates_updated_by_user_id).
CREATE INDEX IF NOT EXISTS idx_inventory_count_drafts_reviewed_by
  ON public.inventory_count_drafts (reviewed_by);
