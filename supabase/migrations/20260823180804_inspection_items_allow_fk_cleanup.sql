-- Let referential cleanup through the immutability wall, and nothing else.
--
-- THE BUG THIS FIXES, WHICH 20260824090000 INTRODUCED
--
-- `inspection_items.repeat_of_work_order_id` references work_orders with
-- ON DELETE SET NULL. That clause is implemented as an UPDATE on
-- inspection_items — and trg_inspection_items_immutable_after_completion
-- rejects every write to a completed inspection's items. So the cascade raised
-- 23001 and the DELETE failed outright:
--
--   ERROR: inspection <id> is completed; its items are immutable
--   CONTEXT: SQL statement "UPDATE ONLY inspection_items
--            SET repeat_of_work_order_id = NULL WHERE ..."
--            SQL statement "DELETE FROM work_orders WHERE id = ..."
--
-- Which means: once any completed inspection recorded a repeat answer against
-- a work order, that work order could never be deleted. Worse, deletes cascade
-- — removing an ORGANIZATION cascades to its work_orders, so a single repeat
-- answer would have made account deletion fail. Found by probing the FK on the
-- E2E project before this reached production; it is not visible from reading
-- either object on its own, because neither is wrong by itself.
--
-- WHY WIDEN THE TRIGGER RATHER THAN CHANGE THE FK
--
-- The alternatives are all worse. CASCADE deletes the finding, and a finding is
-- an immutable record of what someone saw at a property on a date — deleting a
-- work order must never erase it. RESTRICT turns the failure into a permanent
-- one instead of an incidental one. Dropping the FK for a bare uuid gives up
-- referential integrity and leaves dangling ids that later read as real.
--
-- WHAT IS ALLOWED IS DELIBERATELY TINY
--
-- Exactly one shape: an UPDATE that moves `repeat_of_work_order_id` from a
-- value to NULL and leaves every other column identical. That is what the FK
-- cleanup does and it is not an edit to the finding — no answer, note, photo or
-- timestamp can ride along, because the whole record is compared field by
-- field. Setting the column to a DIFFERENT work order is still rejected, so the
-- hole cannot be used to re-point a finding at another job.
--
-- `updated_at` is normalised out of that comparison on purpose. Today the two
-- BEFORE UPDATE triggers happen to fire in an order that leaves it untouched
-- here (immutable… sorts before touch…), but a rename would silently reverse
-- that and turn this back into the same failure. Correctness should not depend
-- on trigger name alphabetisation.

CREATE OR REPLACE FUNCTION reject_completed_inspection_item_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_completed_at timestamptz;
  v_probe        public.inspection_items;
BEGIN
  SELECT completed_at INTO v_completed_at
  FROM public.inspections
  WHERE id = COALESCE(NEW.inspection_id, OLD.inspection_id);

  IF v_completed_at IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- The one permitted write: a foreign-key cleanup nulling the pointer to a
  -- work order that no longer exists.
  IF TG_OP = 'UPDATE'
     AND OLD.repeat_of_work_order_id IS NOT NULL
     AND NEW.repeat_of_work_order_id IS NULL
  THEN
    v_probe := NEW;
    v_probe.repeat_of_work_order_id := OLD.repeat_of_work_order_id;
    v_probe.updated_at              := OLD.updated_at;

    -- Field-by-field, NULL-safe. Anything else differing means this is not a
    -- cleanup and falls through to the rejection below.
    IF v_probe IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'inspection % is completed; its items are immutable', COALESCE(NEW.inspection_id, OLD.inspection_id)
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION reject_completed_inspection_item_edit() IS
  'Freezes a completed inspection''s items. Permits exactly one write: the ON DELETE SET NULL cleanup of repeat_of_work_order_id, which is referential housekeeping rather than an edit to the finding — without it, deleting a referenced work order (or the org that cascades to it) fails.';
