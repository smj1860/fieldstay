-- Phase E: write a whole crew day's plan in one statement.
--
-- The planner produces two timestamps per assignment. Writing them with one
-- UPDATE per row is a textbook N+1 — flagged by
-- unit/guardrails/n-plus-one-loops.test.ts, and correctly: every existing
-- exception in that registry has a STRUCTURAL reason it cannot batch (a
-- parent-before-child id dependency, a per-row generated token, a distinct
-- external resource). Two timestamps keyed by primary key have none, so this
-- is fixed rather than excepted.
--
-- UPDATE ... FROM jsonb_to_recordset, the same shape as
-- apply_inventory_counts. Note the cast list below is what actually rejects a
-- malformed payload, not the column types — the same coupling that migration's
-- header warns about, so the two must move together if the columns ever change.
--
-- Deliberately an UPDATE and not an upsert. An upsert keyed on id would
-- RESURRECT an assignment deleted between the planner's read and its write —
-- a crew member unassigned mid-run would silently get the job back. An UPDATE
-- that matches nothing is the correct outcome there.
--
-- ── AUTHZ: the GRANT is the boundary, not the caller ──
-- SECURITY DEFINER disables RLS inside the body, and p_org_id is supplied by
-- the caller — so without the gate below the ONLY tenant boundary is an
-- argument an attacker chooses. Any function in `public` with EXECUTE granted
-- to `authenticated` is reachable at /rest/v1/rpc/<name> by any signed-in
-- user of any org.
--
-- This is the class 20260801280000_authz_gate_security_definer_rpcs.sql
-- closed, and the first draft of this function reintroduced it. That
-- migration's header anticipates the exact excuse: "the caller passes
-- membership.org_id from requireOrgMember(), never a client-supplied value"
-- is true of the server action and irrelevant, because the server action is
-- not the only caller.
--
-- Two defences, deliberately both:
--
--  1. The is_org_member gate, matching apply_inventory_counts. Service-role
--     callers (the Inngest planner, the only intended one) skip it; anyone
--     else must actually be an admin/manager of the org they named.
--  2. EXECUTE revoked from `authenticated` outright. Nothing legitimate calls
--     this from a browser. Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE
--     on new public functions to `authenticated`, so a bare
--     `REVOKE ... FROM PUBLIC` does NOT remove it — verified by querying
--     proacl, which showed an explicit `authenticated=X/postgres` after the
--     first apply.
--
-- The gate stays even with the revoke, because a future default-privileges
-- change or a careless re-grant would silently restore reachability, and then
-- the gate is the only thing left.
--
-- plan_published_at is NOT touched. Re-planning a published day moves the
-- times and leaves it published, which is what a PM who signed off expects;
-- clearing it would silently un-publish a day they had approved.

CREATE OR REPLACE FUNCTION public.set_turnover_assignment_plans(
  p_org_id uuid,
  p_plans  jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  UPDATE public.turnover_assignments AS a
     SET planned_start_at = p.planned_start_at,
         planned_end_at   = p.planned_end_at
    FROM jsonb_to_recordset(p_plans)
      AS p(id uuid, planned_start_at timestamptz, planned_end_at timestamptz)
   WHERE a.id     = p.id
     AND a.org_id = p_org_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- `authenticated` is named EXPLICITLY. Supabase's default privileges grant it
-- EXECUTE on new public functions, so revoking PUBLIC alone leaves a real
-- grant in place (confirmed in proacl).
REVOKE EXECUTE ON FUNCTION public.set_turnover_assignment_plans(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_turnover_assignment_plans(uuid, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
