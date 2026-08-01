-- ============================================================================
-- REGRESSION FIX: 20260801280000_authz_gate_security_definer_rpcs.sql revoked
-- EXECUTE on next_wo_number(uuid) from `authenticated` on the stated grounds
-- that it has "ZERO callers in app/ or lib/". True of direct callers — and it
-- missed the one that matters: public.assign_wo_number(), the BEFORE INSERT
-- trigger on work_orders, whose entire body is
--
--     IF NEW.wo_number IS NULL THEN NEW.wo_number := next_wo_number(NEW.org_id); END IF;
--
-- assign_wo_number is SECURITY INVOKER, so that call runs with the privileges
-- of whoever is inserting. With the grant gone, EVERY work-order insert made
-- through the RLS-enforced authenticated client fails outright:
--
--     42501  permission denied for function next_wo_number
--
-- Postgres aborts the whole INSERT, so no work order is created at all. This
-- broke createWorkOrder() (PM board), the crew-flag paths in
-- app/api/crew/work-order-reports/route.ts and app/crew/turnovers/actions.ts,
-- and every E2E spec that creates a work order. It is live on BOTH projects.
-- Service-role inserts (Inngest) were unaffected, which is why nothing in the
-- background job surface surfaced it.
--
-- The fix is NOT to restore the grant — that would re-open exactly what
-- 20260801280000 closed (any authenticated user advancing any org's WO number
-- sequence over /rest/v1/rpc/next_wo_number). Instead make the trigger
-- function SECURITY DEFINER so the counter bump runs as the function owner and
-- needs no caller-side grant.
--
-- Safe by construction: assign_wo_number only ever runs on a row whose INSERT
-- already passed the work_orders RLS insert policy, so NEW.org_id is a tenant
-- the caller was already authorized to write. The function touches nothing
-- else, takes no arguments, and cannot be reached over PostgREST (a trigger
-- function returns `trigger`, so it is not exposed as an RPC).
--
-- search_path is pinned explicitly — mandatory on a SECURITY DEFINER function.
--
-- Verified as the only case: of every non-internal trigger function in
-- `public`, assign_wo_number was the sole SECURITY INVOKER one calling a
-- function `authenticated` can no longer execute. The five crew_sync_on_*
-- triggers also call a revoked function (notify_crew_sync) but are already
-- SECURITY DEFINER and were never affected.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assign_wo_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.wo_number IS NULL THEN
    NEW.wo_number := next_wo_number(NEW.org_id);
  END IF;
  RETURN NEW;
END;
$$;

-- The trigger machinery does not check EXECUTE on a trigger function, so no
-- grant is needed here — and none is given, deliberately.
REVOKE EXECUTE ON FUNCTION public.assign_wo_number() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
