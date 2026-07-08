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
-- ============================================================
-- Security & idempotency hardening
-- 1. Add uplisting_booking to owner_transactions source CHECK
-- 2. Restrict next_wo_number and cleanup_expired_oauth_states
--    to authenticated/service_role only (block anon tampering)
-- 3. Pin search_path on all public functions (schema injection
--    defence-in-depth for SECURITY DEFINER functions)
-- 4. Replace inventory_count_drafts / draft_items policies
--    with invite_accepted_at-safe versions
-- ============================================================

-- ── 1. owner_transactions CHECK constraint ───────────────────
ALTER TABLE owner_transactions DROP CONSTRAINT owner_transactions_source_check;
ALTER TABLE owner_transactions ADD CONSTRAINT owner_transactions_source_check
  CHECK (source = ANY (ARRAY[
    'manual'::text,
    'wo_completion'::text,
    'booking_revenue'::text,
    'uplisting_booking'::text,
    'inventory_purchase'::text,
    'cleaning_fee'::text
  ]));

-- ── 2. Function execute permissions ─────────────────────────

-- next_wo_number: anon can tamper with WO counters via RPC — restrict
REVOKE EXECUTE ON FUNCTION public.next_wo_number(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.next_wo_number(uuid) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.next_wo_number(uuid) TO service_role;

-- cleanup_expired_oauth_states: anon-callable SECURITY DEFINER — restrict to service_role
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_oauth_states() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cleanup_expired_oauth_states() TO service_role;

-- RLS helper functions: remove anon access, keep authenticated + service_role
REVOKE EXECUTE ON FUNCTION public.get_user_org_ids()                         FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_user_org_ids()                         TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_user_org_ids()                         TO service_role;

REVOKE EXECUTE ON FUNCTION public.is_org_member(uuid, member_role[])         FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_org_member(uuid, member_role[])         TO authenticated;
GRANT  EXECUTE ON FUNCTION public.is_org_member(uuid, member_role[])         TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_crew_member_id()                       FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_crew_member_id()                       TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_crew_member_id()                       TO service_role;

-- Trigger-only functions: no user or anon access needed
REVOKE EXECUTE ON FUNCTION public.assign_wo_number()                         FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_updated_at()                           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_powersync_crew_on_assignment()        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_powersync_crew_on_instance()          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_comm_log_updated_at()                  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_wo_actual_cost()                      FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.assign_wo_number()                         TO service_role;
GRANT  EXECUTE ON FUNCTION public.set_updated_at()                           TO service_role;
GRANT  EXECUTE ON FUNCTION public.handle_new_user()                          TO service_role;
GRANT  EXECUTE ON FUNCTION public.sync_powersync_crew_on_assignment()        TO service_role;
GRANT  EXECUTE ON FUNCTION public.sync_powersync_crew_on_instance()          TO service_role;
GRANT  EXECUTE ON FUNCTION public.set_comm_log_updated_at()                  TO service_role;
GRANT  EXECUTE ON FUNCTION public.sync_wo_actual_cost()                      TO service_role;

-- ── 3. Pin search_path on all public functions ───────────────
ALTER FUNCTION public.get_user_org_ids()                       SET search_path = public;
ALTER FUNCTION public.is_org_member(uuid, member_role[])       SET search_path = public;
ALTER FUNCTION public.next_wo_number(uuid)                     SET search_path = public;
ALTER FUNCTION public.assign_wo_number()                       SET search_path = public;
ALTER FUNCTION public.set_updated_at()                         SET search_path = public;
ALTER FUNCTION public.cleanup_expired_oauth_states()           SET search_path = public;
ALTER FUNCTION public.sync_powersync_crew_on_assignment()      SET search_path = public;
ALTER FUNCTION public.sync_powersync_crew_on_instance()        SET search_path = public;
ALTER FUNCTION public.get_crew_member_id()                     SET search_path = public;
ALTER FUNCTION public.handle_new_user()                        SET search_path = public;
ALTER FUNCTION public.set_comm_log_updated_at()                SET search_path = public;
ALTER FUNCTION public.sync_wo_actual_cost()                    SET search_path = public;

-- ── 4. inventory_count_drafts / draft_items RLS ──────────────

-- Drop old policies that skip invite_accepted_at check
DROP POLICY IF EXISTS "org members can manage inventory count drafts"      ON inventory_count_drafts;
DROP POLICY IF EXISTS "org members can manage inventory count draft items" ON inventory_count_draft_items;

-- inventory_count_drafts: read for all accepted members
CREATE POLICY "icd_select"
  ON inventory_count_drafts FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- inventory_count_drafts: write for admins/managers (review, approve, reject, update)
CREATE POLICY "icd_manage"
  ON inventory_count_drafts FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- inventory_count_drafts: crew can only create their own drafts
CREATE POLICY "icd_crew_insert"
  ON inventory_count_drafts FOR INSERT
  WITH CHECK (submitted_by = auth.uid());

-- inventory_count_draft_items: read scoped through draft → org membership
CREATE POLICY "icdi_select"
  ON inventory_count_draft_items FOR SELECT
  USING (
    draft_id IN (
      SELECT id FROM inventory_count_drafts
      WHERE org_id IN (SELECT get_user_org_ids())
    )
  );

-- inventory_count_draft_items: admins/managers can manage all items
CREATE POLICY "icdi_manage"
  ON inventory_count_draft_items FOR ALL
  USING (
    draft_id IN (
      SELECT d.id FROM inventory_count_drafts d
      WHERE is_org_member(d.org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  )
  WITH CHECK (
    draft_id IN (
      SELECT d.id FROM inventory_count_drafts d
      WHERE is_org_member(d.org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  );

-- inventory_count_draft_items: crew can insert items only into their own drafts
CREATE POLICY "icdi_crew_insert"
  ON inventory_count_draft_items FOR INSERT
  WITH CHECK (
    draft_id IN (
      SELECT id FROM inventory_count_drafts
      WHERE submitted_by = auth.uid()
    )
  );
