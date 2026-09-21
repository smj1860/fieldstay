-- ============================================================================
-- [MEDIUM] set_sponsor_properties() has no locking around its read-diff-write
-- sequence.
--
-- The function (20260915143000_guidebook_sponsor_assignments_cap_and_atomic_
-- writes.sql) reads the sponsor's CURRENT property assignments, diffs that
-- against the requested set to compute toAdd/toRemove, then applies both —
-- all as plain reads and writes with no lock in between:
--
--   SELECT ... INTO v_current FROM guidebook_sponsor_assignments WHERE ...
--   -- diff computed here --
--   DELETE ... WHERE property_id = ANY(v_to_remove);
--   INSERT ... SELECT ... FROM unnest(v_to_add);
--
-- Classic TOCTOU: two concurrent calls for the SAME sponsor (the PM
-- double-clicking Save, or a retried Server Action after a slow response)
-- both read the same v_current snapshot, compute overlapping-but-different
-- diffs, and interleave their DELETE/INSERT statements. Depending on
-- interleaving this either re-inserts a property the other call just
-- removed (surviving as a live assignment when the PM's last click was to
-- remove it — an unhandled 23505 on the OTHER caller's INSERT if the rows
-- collide exactly, or a silent double-write if they don't), or has one
-- call's update silently overwritten by the other's — the write that
-- commits last wins, with nothing to flag that the caller's own diff never
-- saw the winner's changes.
--
-- FIX: lock the sponsor row itself before doing anything else, so two
-- concurrent calls for the same p_sponsor_id serialize — the second call's
-- `FOR UPDATE` blocks until the first COMMITs, and only then does its own
-- fresh SELECT ... INTO v_current, which by then reflects the first call's
-- completed write. This is the standard "lock the parent row to serialize a
-- read-diff-write over its children" pattern: guidebook_sponsors has no
-- columns this function needs to read, so `PERFORM 1 ... FOR UPDATE` (lock
-- and discard, rather than SELECT INTO an unused variable) is the correct
-- shape. Scoped to ONE sponsor's row — concurrent calls for two DIFFERENT
-- sponsors are unaffected and do not serialize against each other.
--
-- Everything else in the function is reproduced byte-for-byte from
-- 20260915143000. replace_property_sponsors (the sibling per-property path)
-- is NOT touched by this migration — it has no read-diff-write sequence to
-- race (it unconditionally deletes-then-inserts the full set with no prior
-- read informing what it writes), so it carries no equivalent TOCTOU.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_sponsor_properties(
  p_org_id      uuid,
  p_sponsor_id  uuid,
  p_property_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_current   uuid[];
  v_to_add    uuid[];
  v_to_remove uuid[];
BEGIN
  -- Lock the sponsor row FIRST, before the read-diff-write sequence below.
  -- Two concurrent calls for the SAME sponsor now serialize here: the
  -- second caller blocks until the first commits, so its own v_current read
  -- (next line) is guaranteed to see the first call's completed write
  -- rather than racing against it. See header comment.
  PERFORM 1 FROM public.guidebook_sponsors WHERE id = p_sponsor_id FOR UPDATE;

  SELECT COALESCE(array_agg(property_id), ARRAY[]::uuid[]) INTO v_current
    FROM public.guidebook_sponsor_assignments
   WHERE org_id = p_org_id AND sponsor_id = p_sponsor_id;

  SELECT COALESCE(array_agg(pid), ARRAY[]::uuid[]) INTO v_to_add
    FROM unnest(p_property_ids) AS pid
   WHERE pid <> ALL(v_current);

  SELECT COALESCE(array_agg(pid), ARRAY[]::uuid[]) INTO v_to_remove
    FROM unnest(v_current) AS pid
   WHERE pid <> ALL(p_property_ids);

  IF array_length(v_to_remove, 1) > 0 THEN
    DELETE FROM public.guidebook_sponsor_assignments
     WHERE org_id = p_org_id
       AND sponsor_id = p_sponsor_id
       AND property_id = ANY(v_to_remove);
  END IF;

  IF array_length(v_to_add, 1) > 0 THEN
    INSERT INTO public.guidebook_sponsor_assignments (org_id, sponsor_id, property_id, slot_type)
    SELECT p_org_id, p_sponsor_id, pid, 'general'
      FROM unnest(v_to_add) AS pid;
    -- Same whole-function rollback guarantee as replace_property_sponsors:
    -- a cap/collision violation here undoes the removals above too.
  END IF;

  RETURN jsonb_build_object(
    'added',   COALESCE(v_to_add, ARRAY[]::uuid[]),
    'removed', COALESCE(v_to_remove, ARRAY[]::uuid[])
  );
END;
$$;

COMMENT ON FUNCTION public.set_sponsor_properties(uuid, uuid, uuid[]) IS
  'Diffs and applies a sponsor''s full property-assignment set atomically. '
  'Locks the guidebook_sponsors row (FOR UPDATE) before its read-diff-write '
  'sequence — see 20260916004000_set_sponsor_properties_lock.sql — so two '
  'concurrent calls for the SAME sponsor serialize instead of racing on '
  'guidebook_sponsor_assignments.';

-- Grants unchanged from 20260915143000 (service_role only; REVOKE/GRANT are
-- idempotent no-ops here since CREATE OR REPLACE FUNCTION does not reset
-- existing grants, but restated for clarity and to survive a future DROP).
REVOKE EXECUTE ON FUNCTION public.set_sponsor_properties(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_sponsor_properties(uuid, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';
