-- Correction to claude_61_0_security_hardening: that migration revoked
-- EXECUTE on replace_master_checklist_items from `authenticated` and granted
-- only `service_role`. That breaks the function entirely, because its new
-- internal guard calls is_org_member(p_org_id, ...), which depends on
-- auth.uid() — populated only when the request carries the calling user's
-- JWT (the normal requireOrgMember()-scoped client used by
-- saveMasterChecklistItems in app/(dashboard)/setup/checklist-template/actions.ts).
-- createServiceClient() uses the service_role key with no forwarded user
-- token, so auth.uid() is NULL there and the guard would reject every call,
-- including legitimate ones — routing through the service client is not a
-- viable fix either.
--
-- The internal is_org_member() guard is what actually closes the
-- vulnerability (a caller can no longer spoof p_org_id to wipe another org's
-- checklist). Restoring EXECUTE to `authenticated` is required for the
-- feature to keep working and does not reopen the hole.

GRANT EXECUTE ON FUNCTION public.replace_master_checklist_items(uuid, jsonb)
  TO authenticated;
