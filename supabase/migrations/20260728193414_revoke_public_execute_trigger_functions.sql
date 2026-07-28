-- These three functions are trigger-only (reference NEW/OLD, which don't
-- exist outside trigger context) but were still exposed as public RPC
-- endpoints by default. Revoking EXECUTE from anon/authenticated closes
-- that surface with zero functional impact — triggers invoke functions
-- directly, independent of role-level EXECUTE grants, so existing trigger
-- behavior is unaffected.
REVOKE EXECUTE ON FUNCTION public.prevent_room_template_is_system_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.protect_checklist_instances_crew_columns() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_checklist_instance_started_at() FROM PUBLIC;
