-- ============================================================================
-- Close two SECURITY DEFINER functions that were executable through PostgREST
-- by roles that never need them (Supabase security advisors 0028 / 0029).
--
--   apply_friction_grading(p_org_id uuid)
--     Callable by `anon` and `authenticated` via /rest/v1/rpc/, with NO internal
--     caller check, for ANY org id. Its only caller is the service-role Inngest
--     per-org handler (friction-grading.ts). Grading is one-shot (graded_at), so
--     letting an outside caller trigger it for another tenant could grade rows
--     before the cron's own readiness gate intended.
--
--   enforce_property_plan_limit()
--     A trigger function. Trigger functions are not invoked through EXECUTE
--     privilege at fire time (it is checked at CREATE TRIGGER), so revoking is
--     safe and removes a pointless RPC surface.
--
-- `authenticated` is named explicitly: Supabase default privileges grant it
-- EXECUTE on new public functions, so REVOKE ... FROM PUBLIC alone is not
-- enough (see 20261012190000_set_turnover_assignment_plans.sql).
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.apply_friction_grading(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_friction_grading(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.enforce_property_plan_limit()
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
