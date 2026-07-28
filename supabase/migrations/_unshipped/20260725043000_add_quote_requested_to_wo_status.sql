-- SUPERSEDED — moved to _unshipped/ during the 2026-07-28 migration-drift
-- reconciliation (Task 4). Confirmed via Supabase MCP list_migrations that
-- this file's version was never recorded in supabase_migrations.schema_migrations,
-- and via live schema introspection (information_schema.tables/columns,
-- pg_proc, pg_indexes) that every table/column/index/function/policy this
-- file targets already exists in the live database — applied under a
-- different, real-timestamped migration that superseded this draft. Kept
-- for historical reference only; do not run.
-- ---------------------------------------------------------------------------

-- wo_status.quote_requested exists on the production project but was never
-- captured in a tracked migration (added out-of-band at some point after
-- the original 20260524165615_fieldstay_v1_extensions_enums.sql, which only
-- defines pending/assigned/in_progress/completed/cancelled). The E2E project
-- (created fresh from migrations alone) never got it, so every query
-- filtering work_orders.status with 'quote_requested' in the list — e.g.
-- app/(dashboard)/maintenance/page.tsx's board query — throws "invalid
-- input value for enum wo_status" there, silently (the query's `error` is
-- never checked), making every work order vanish from the board.
ALTER TYPE wo_status ADD VALUE IF NOT EXISTS 'quote_requested' AFTER 'pending';
