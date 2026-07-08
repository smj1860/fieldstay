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
-- PM-initiated inventory counts: additive INSERT policies for admin/manager roles.
-- The existing crew-scoped policies (inventory_counts_crew_insert,
-- count_items_crew_insert) are untouched — Postgres OR's permissive policies
-- for the same command, so crew submissions continue to work as before.

CREATE POLICY "inventory_counts_admin_manager_insert"
  ON inventory_counts
  FOR INSERT
  WITH CHECK (
    is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  );

CREATE POLICY "count_items_admin_manager_insert"
  ON inventory_count_items
  FOR INSERT
  WITH CHECK (
    count_id IN (
      SELECT ic.id FROM inventory_counts ic
      WHERE is_org_member(ic.org_id, ARRAY['admin'::member_role, 'manager'::member_role])
    )
  );
