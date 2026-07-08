-- ─────────────────────────────────────────────────────────────────────────
-- NOT RECORDED IN LIVE MIGRATION HISTORY: verified via Supabase MCP
-- list_migrations against project vpmznjktllhmmbfnxuvk on 2026-07-08 that
-- this file's version is absent from supabase_migrations.schema_migrations.
-- Spot-checking the schema objects it defines (tables, columns, indexes,
-- functions, policies, enum values, dropped objects) against the live
-- database confirms they already exist — this SQL was applied previously,
-- most likely by hand or under a different, already-tracked migration
-- timestamp, and this file is a historical/duplicate copy rather than a
-- pending change. Do not assume `supabase db push` needs to run it, and
-- verify against the live schema before treating it as authoritative —
-- some statements here (UPDATEs, INSERTs, ALTER TYPE ... ADD VALUE) are
-- not safely re-runnable if actually executed again.
-- ─────────────────────────────────────────────────────────────────────────
-- CLAUDE_61_0: Security hardening
--
-- Fix 1: replace_master_checklist_items was SECURITY DEFINER + GRANT to
--         authenticated with no org-membership check — any logged-in user
--         could wipe and replace another org's entire checklist catalog via
--         a direct PostgREST RPC call.
--
-- Fix 2: Confirmed (via full-migration-history scan, not just the two files
--         named in the audit) that four live UPDATE policies use USING
--         without a matching WITH CHECK, meaning the policy restricts which
--         rows can be selected for update but not what values can be written
--         into them:
--           - organizations.orgs_update
--           - organization_members.org_members_admin_manage
--           - guidebook_configurations.gc_org_members_update
--           - guidebook_sponsors.gs_org_members_update
--         (vendor_compliance_documents, maintenance_schedules, and
--         work_order_updates — named in the audit doc's hint list — were
--         checked and already have correct WITH CHECK clauses, or have no
--         UPDATE policy at all; not touched here.)
--
-- Fix 3: ownerrez_processed_webhooks had no TTL cleanup — rows accumulate
--         forever. Add a helper function the webhook route calls on a
--         sample of requests to delete rows older than 72 hours.

-- ── Fix 1: Secure replace_master_checklist_items ─────────────────────────────

REVOKE EXECUTE ON FUNCTION public.replace_master_checklist_items(uuid, jsonb)
  FROM authenticated;

CREATE OR REPLACE FUNCTION public.replace_master_checklist_items(
  p_org_id uuid,
  p_items  jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Caller must be admin or manager of the target org.
  -- is_org_member() uses auth.uid() internally — cannot be spoofed by p_org_id.
  IF NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'Access denied: caller is not an admin or manager of org %', p_org_id
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.org_master_checklist_items
  WHERE org_id = p_org_id;

  IF jsonb_array_length(p_items) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.org_master_checklist_items (org_id, section, task, sort_order, source)
  SELECT
    p_org_id,
    (item ->> 'section'),
    (item ->> 'task'),
    (item ->> 'sort_order')::int,
    (item ->> 'source')
  FROM jsonb_array_elements(p_items) AS item;
END;
$$;

GRANT EXECUTE ON FUNCTION public.replace_master_checklist_items(uuid, jsonb)
  TO service_role;

-- ── Fix 2: Add WITH CHECK to UPDATE policies missing it ──────────────────────

DROP POLICY IF EXISTS "orgs_update" ON public.organizations;
CREATE POLICY "orgs_update" ON public.organizations FOR UPDATE
  USING      (is_org_member(id, ARRAY['admin'::member_role]))
  WITH CHECK (is_org_member(id, ARRAY['admin'::member_role]));

DROP POLICY IF EXISTS "org_members_admin_manage" ON public.organization_members;
CREATE POLICY "org_members_admin_manage" ON public.organization_members FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role]));

DROP POLICY IF EXISTS "gc_org_members_update" ON public.guidebook_configurations;
CREATE POLICY "gc_org_members_update" ON public.guidebook_configurations FOR UPDATE
  USING      (org_id IN (SELECT get_user_org_ids()))
  WITH CHECK (org_id IN (SELECT get_user_org_ids()));

DROP POLICY IF EXISTS "gs_org_members_update" ON public.guidebook_sponsors;
CREATE POLICY "gs_org_members_update" ON public.guidebook_sponsors FOR UPDATE
  USING      (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- ── Fix 3: Webhook dedup TTL cleanup helper ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.cleanup_ownerrez_webhook_dedup()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.ownerrez_processed_webhooks
  WHERE processed_at < now() - INTERVAL '72 hours';
$$;

REVOKE ALL ON FUNCTION public.cleanup_ownerrez_webhook_dedup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_ownerrez_webhook_dedup() TO service_role;
