-- The prior revoke was ineffective because EXECUTE was held via PUBLIC.
-- Revoke from PUBLIC and re-grant narrowly.

-- 1. Pure trigger functions: no role needs EXECUTE (triggers fire regardless).
REVOKE EXECUTE ON FUNCTION public.populate_checklist_item_turnover_id()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.populate_turnover_assignment_denorm()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_turnover_assignment_property_id()     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_turnover_assignment_user_id()         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_non_deletable_checklist_mutation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_non_deletable_checklist_update()   FROM PUBLIC, anon, authenticated;

-- 2. Dashboard/crew/platform-only definer helpers: drop PUBLIC + anon,
--    keep signed-in users and server (service_role) callers.
DO $$
DECLARE fn text;
BEGIN
  FOR fn IN
    SELECT unnest(ARRAY[
      'public.is_platform_staff()',
      'public.get_crew_member_id()',
      'public.get_crew_turnover_ids()',
      'public.get_asset_repair_summary()',
      'public.get_repeat_issues(timestamp with time zone)',
      'public.replace_master_checklist_items(uuid, jsonb)',
      'public.next_wo_number(uuid)',
      'public.match_kb_chunks(public.vector, integer, double precision)'
    ])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon;', fn);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO authenticated, service_role;', fn);
  END LOOP;
END $$;

-- Note: is_org_member() and get_user_org_ids() are intentionally left granted to
-- authenticated — they are the canonical RLS helpers referenced by policies across
-- every table, so authenticated MUST retain EXECUTE. The residual
-- "authenticated can execute SECURITY DEFINER" advisor notices on these (and the
-- other helpers above) are expected and accepted for this RLS pattern.

NOTIFY pgrst, 'reload schema';
