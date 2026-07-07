-- Close the Supabase security-advisor findings that are safe to fix without
-- risking RLS: (a) pin search_path on functions flagged mutable, and
-- (b) stop trigger/internal SECURITY DEFINER functions being callable via the
-- exposed PostgREST RPC surface. Core RLS helpers (is_org_member, get_user_org_ids)
-- keep their authenticated EXECUTE grant because RLS policy evaluation needs it.

-- 1. Pin search_path (function_search_path_mutable)
ALTER FUNCTION public.prevent_non_deletable_checklist_mutation() SET search_path = public;
ALTER FUNCTION public.prevent_non_deletable_checklist_update()   SET search_path = public;
ALTER FUNCTION public.is_platform_staff()                        SET search_path = public;
ALTER FUNCTION public.match_kb_chunks(public.vector, integer, double precision) SET search_path = public, extensions;

-- 2. Trigger / internal functions must never be invokable as RPCs.
--    (Trigger execution does not require EXECUTE on the invoking role, so this
--     is safe — the triggers keep firing.)
REVOKE EXECUTE ON FUNCTION public.populate_checklist_item_turnover_id()      FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.populate_turnover_assignment_denorm()      FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_turnover_assignment_property_id()     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_turnover_assignment_user_id()         FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_non_deletable_checklist_mutation() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_non_deletable_checklist_update()   FROM anon, authenticated;

-- 3. Definer helpers that are dashboard/crew/platform-only: remove anon exposure.
--    authenticated retained (used by the app and/or RLS).
REVOKE EXECUTE ON FUNCTION public.is_platform_staff()                              FROM anon;
REVOKE EXECUTE ON FUNCTION public.match_kb_chunks(public.vector, integer, double precision) FROM anon;

NOTIFY pgrst, 'reload schema';
