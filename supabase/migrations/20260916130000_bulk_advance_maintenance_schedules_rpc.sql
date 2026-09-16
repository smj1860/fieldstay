-- ============================================================================
-- SCALABILITY: advanceSchedulesAfterCompletion() batched the READ (one
-- .in() query for every source schedule behind a completed batch) but still
-- fired ONE .update() PER SCHEDULE, fanned out with Promise.allSettled. A
-- single PM bulk-completing 500 work orders at month end produced 500
-- simultaneous UPDATE round trips against maintenance_schedules; at 100x
-- traffic (many PMs bulk-completing at once) that fan-out is the request
-- path's own thundering herd against Postgres, not just this one org's
-- problem.
--
-- Fix: one set-based UPDATE ... FROM jsonb_to_recordset(...), the same shape
-- already used for apply_inventory_counts (20260801260000) and
-- apply_asset_health_scores (20260808180000) — and for THIS SAME TABLE by
-- broadcast_maintenance_schedules (20260915152000).
--
-- SECURITY DEFINER vs INVOKER: this table's own RLS write policy
-- (maintenance_schedules_update) already grants exactly the access this RPC
-- needs — is_org_member(org_id, ['admin','manager']) — and every current
-- caller of advanceSchedulesAfterCompletion() is either an RLS-enforced
-- client from requireOrgRole(['admin','manager']) (the PM completion paths in
-- app/(dashboard)/maintenance/{actions,work-order-actions}.ts) or a
-- service-role client (the crew completion route, which bypasses RLS by
-- design). SECURITY INVOKER (the default — no marker) lets RLS itself be the
-- enforcement for the first case and is a no-op restriction for the second,
-- rather than hand-duplicating an auth check that can drift from the real
-- policy — the same reasoning broadcast_maintenance_schedules_rpc.sql's own
-- comment gives for the identical choice on this identical table. The
-- explicit `s.org_id = p_org_id` predicate is still here as defense in depth
-- (matching the `.eq('org_id', orgId)` every pre-existing per-row .update()
-- call already carried), not as the sole boundary.
--
-- next_due_date is COALESCEd rather than overwritten unconditionally: a
-- non-routine (or frequency-less) schedule only ever advances
-- last_completed_date, and must leave its stored next_due_date exactly alone
-- — the caller sends NULL for that column on those rows, never a value to
-- clobber the existing one with.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bulk_advance_maintenance_schedules(
  p_org_id  uuid,
  p_updates jsonb
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_applied integer := 0;
BEGIN
  UPDATE maintenance_schedules AS s
     SET last_completed_date = u.last_completed_date,
         next_due_date       = COALESCE(u.next_due_date, s.next_due_date)
    FROM jsonb_to_recordset(coalesce(p_updates, '[]'::jsonb))
      AS u(id uuid, last_completed_date date, next_due_date date)
   WHERE s.id     = u.id
     AND s.org_id = p_org_id;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  RETURN v_applied;
END;
$$;

COMMENT ON FUNCTION public.bulk_advance_maintenance_schedules(uuid, jsonb) IS
  'Set-based replacement for a per-schedule .update() loop in '
  'advanceSchedulesAfterCompletion() (app/(dashboard)/maintenance/'
  'complete-work-order-helpers.ts) — one UPDATE...FROM jsonb_to_recordset '
  'instead of one round trip per completed work order''s source schedule. '
  'next_due_date is COALESCEd so a row that only advances last_completed_date '
  '(a non-routine or frequency-less schedule) leaves its existing '
  'next_due_date untouched rather than being overwritten with NULL. '
  'SECURITY INVOKER (default): relies on maintenance_schedules_update RLS for '
  'an authenticated caller and on service_role''s RLS bypass for the crew '
  'completion route, same as broadcast_maintenance_schedules(); the explicit '
  'org_id predicate is defense in depth, not the sole boundary.';

REVOKE ALL ON FUNCTION public.bulk_advance_maintenance_schedules(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_advance_maintenance_schedules(uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
