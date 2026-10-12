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
-- p_org_id is a required argument and filters every row. The caller is a
-- service-role Inngest step, so RLS is not the backstop here; the explicit
-- org filter is, per CLAUDE.md's tenant-isolation rule.
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

REVOKE EXECUTE ON FUNCTION public.set_turnover_assignment_plans(uuid, jsonb) FROM PUBLIC, anon;
-- service_role only: the only caller is the Inngest planner. A PM never writes
-- these times directly, and granting authenticated would make the plan
-- editable from a browser session with nothing checking the sequence is sane.
GRANT  EXECUTE ON FUNCTION public.set_turnover_assignment_plans(uuid, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
