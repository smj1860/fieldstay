-- ============================================================================
-- reject_completed_inspection_item_edit()'s guard against writing to the items
-- of a completed inspection has an unlocked TOCTOU read.
--
-- The trigger does a plain SELECT of the parent inspection's completed_at:
--
--   SELECT completed_at INTO v_completed_at
--   FROM public.inspections
--   WHERE id = COALESCE(NEW.inspection_id, OLD.inspection_id);
--
-- A plain (non-locking) SELECT in Postgres never blocks on another
-- transaction's row lock — it only ever sees the last COMMITTED value. So
-- while submit_inspection() is mid-flight (it takes `SELECT ... FOR UPDATE`
-- on the inspections row, inserts every item, then finally
-- `UPDATE inspections SET completed_at = now()`), a completely separate
-- transaction writing to inspection_items for that SAME inspection runs
-- this trigger's SELECT and sees completed_at still NULL — the value from
-- before submit_inspection() started, because submit_inspection() has not
-- committed yet. The guard passes, the edit lands, and only AFTER that does
-- submit_inspection() commit the completion. The FOR UPDATE lock
-- submit_inspection() takes never protected this at all, because a row lock
-- only blocks other LOCKING reads/writes, never a bare SELECT.
--
-- Net effect: an item can be inserted, updated or deleted for an inspection
-- in the exact window it is being completed, with neither transaction ever
-- seeing an error — the one guarantee §1 of the spec calls "a higher bar
-- than an owner-facing PDF" (see 20260822090115_inspections_phase1.sql) is
-- exactly the guarantee this race can defeat.
--
-- Fix: `FOR SHARE` on the same read. A share lock is compatible with other
-- share locks (many concurrent legitimate answer-saves on the SAME
-- inspection, before it is completed, never block each other) but conflicts
-- with submit_inspection()'s `FOR UPDATE` — so a competing writer's trigger
-- now genuinely WAITS for submit_inspection() to commit or roll back before
-- reading completed_at, and then reads the value submit_inspection() actually
-- left behind. No deadlock risk from submit_inspection()'s own item inserts:
-- a transaction never blocks on a lock it already holds, and FOR UPDATE is
-- strictly stronger than FOR SHARE, so submit_inspection()'s own trigger-fired
-- SELECT ... FOR SHARE on a row it already holds FOR UPDATE on is an
-- immediate no-op re-acquisition, not a wait.
-- ============================================================================

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
  WHERE id = COALESCE(NEW.inspection_id, OLD.inspection_id)
  FOR SHARE;

  IF v_completed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'inspection % is completed; its items are immutable', COALESCE(NEW.inspection_id, OLD.inspection_id)
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
