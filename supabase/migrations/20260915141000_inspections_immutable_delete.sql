-- ============================================================================
-- Completed inspections could be DELETEd outright, destroying supposedly
-- immutable insurance evidence.
--
-- 20260822090115_inspections_phase1.sql's "Immutability" section only guards
-- UPDATE on inspections (trg_inspections_immutable_after_completion is
-- BEFORE UPDATE only) and INSERT/UPDATE/DELETE on inspection_items directly.
-- There has never been a BEFORE DELETE trigger on inspections itself, and
-- inspections_manage's RLS policy is FOR ALL with no completed_at condition,
-- with DELETE explicitly GRANTed to authenticated — so any admin/manager
-- could delete a completed inspection through the ordinary Supabase client.
--
-- Worse, the item-level guard does not save it: inspection_items.inspection_id
-- is ON DELETE CASCADE, and when the cascade fires as part of the same DELETE
-- statement, reject_completed_inspection_item_edit()'s
-- `SELECT completed_at FROM inspections WHERE id = ...` finds no row — the
-- parent is already gone from that command's view (MVCC + cascades run within
-- the same command) — so v_completed_at is NULL from "not found," not from
-- the inspection genuinely being incomplete, and the guard's
-- `IF v_completed_at IS NOT NULL` is false. The exact tampering the item
-- trigger's own comment says it exists to prevent goes through cleanly via
-- the parent.
--
-- Fix: block the parent DELETE directly. With this trigger in place, a
-- completed inspection's row delete never starts, so the cascade to
-- inspection_items never fires either — no change needed to the item-level
-- trigger.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reject_completed_inspection_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'inspection % is completed and immutable (completed_at %)', OLD.id, OLD.completed_at
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_inspections_immutable_delete ON public.inspections;
CREATE TRIGGER trg_inspections_immutable_delete
  BEFORE DELETE ON public.inspections
  FOR EACH ROW EXECUTE FUNCTION public.reject_completed_inspection_delete();
