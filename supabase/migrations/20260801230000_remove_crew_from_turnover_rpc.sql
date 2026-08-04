-- ============================================================================
-- removeCrewFromTurnover becomes one transaction.
--
-- The server action did: verify the turnover, DELETE the assignment, COUNT the
-- remaining assignments, then conditionally revert the turnover to
-- 'pending_assignment' when the count reached zero. Three problems:
--
--   1. TOCTOU. Two concurrent removals (two PMs, or a double-click) can each
--      run their COUNT before the other's DELETE commits. Both see a non-zero
--      remaining count, both skip the revert, and the turnover is left
--      `assigned` with ZERO crew — which takes it off the needs-assignment
--      board entirely, so nobody is prompted to staff it and the checkout is
--      quietly unstaffed.
--   2. The DELETE's result was discarded. A failed delete fell through to the
--      count, saw the crew member still present, skipped the revert, and the
--      action returned success — telling the PM someone was removed who was not.
--   3. The status UPDATE's result was discarded too.
--
-- Inside one function body the lock makes delete-count-revert a single atomic
-- decision, so the count can never observe a half-applied concurrent removal.
--
-- Returns the outcome rather than raising for the ordinary "not found" cases,
-- so the caller can distinguish them; genuine errors still propagate.
--
-- Grants: authenticated (the caller is a normal RLS-scoped server action) plus
-- service_role. SECURITY DEFINER means RLS does not apply inside the body, so
-- the explicit p_org_id check below IS the tenant boundary — the caller passes
-- membership.org_id from requireOrgMember(), never a client-supplied value.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.remove_crew_from_turnover(
  p_turnover_id    uuid,
  p_crew_member_id uuid,
  p_org_id         uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status    turnover_status;
  v_deleted   integer := 0;
  v_remaining integer := 0;
  v_reverted  boolean := false;
BEGIN
  -- Lock the turnover: this is what serialises concurrent removals, so the
  -- count below cannot straddle another transaction's delete.
  SELECT status INTO v_status
    FROM public.turnovers
   WHERE id = p_turnover_id
     AND org_id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'turnover_not_found');
  END IF;

  DELETE FROM public.turnover_assignments
   WHERE turnover_id    = p_turnover_id
     AND crew_member_id = p_crew_member_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted = 0 THEN
    -- Nothing was assigned to remove. Reported rather than silently treated as
    -- success, because the previous code could not tell this apart from a
    -- failed delete.
    RETURN jsonb_build_object('ok', false, 'reason', 'assignment_not_found');
  END IF;

  SELECT count(*) INTO v_remaining
    FROM public.turnover_assignments
   WHERE turnover_id = p_turnover_id;

  IF v_remaining = 0 AND v_status = 'assigned' THEN
    UPDATE public.turnovers
       SET status = 'pending_assignment'
     WHERE id = p_turnover_id
       AND org_id = p_org_id;
    v_reverted := true;
  END IF;

  RETURN jsonb_build_object(
    'ok',        true,
    'remaining', v_remaining,
    'reverted',  v_reverted
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.remove_crew_from_turnover(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.remove_crew_from_turnover(uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
