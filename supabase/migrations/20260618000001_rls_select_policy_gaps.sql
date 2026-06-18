-- ─────────────────────────────────────────────────────────────────────────────
-- Fix RLS SELECT policy gaps (Security Audit #2 findings):
--   org_master_checklist_items, org_master_maintenance_schedules,
--   owner_transactions
--
-- All three tables currently only have an ALL policy gated to admin/manager
-- via is_org_member(). That means crew/viewer-role org members get zero rows
-- back on a plain SELECT — even though org_master_* are read-only seed
-- reference data, and owner_transactions is the P&L ledger viewers should be
-- able to read. Add the standard `_select` policy (any org member, via
-- get_user_org_ids()) alongside the existing ALL policy, which continues to
-- gate INSERT/UPDATE/DELETE to admin/manager.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "org_master_checklist_items_select"
  ON public.org_master_checklist_items FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "org_master_maintenance_schedules_select"
  ON public.org_master_maintenance_schedules FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "owner_transactions_select"
  ON public.owner_transactions FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- ─────────────────────────────────────────────────────────────────────────────
-- oauth_states — documented no-op, no policy change.
--
-- Confirmed RLS enabled with zero policies: authenticated/anon are denied by
-- default, and only service_role (which bypasses RLS) can read or write. This
-- is intentional — oauth_states holds CSRF state tokens written and consumed
-- server-side during the OAuth initiate/callback flow and never need to be
-- readable from a user session. Documenting this here matches the precedent
-- set for stripe_processed_events and wo_number_counters in
-- 20260609000008_grant_missing_tables_vendor_address.sql.
-- ─────────────────────────────────────────────────────────────────────────────
