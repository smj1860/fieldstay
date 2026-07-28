-- SUPERSEDED — moved to _unshipped/ during the 2026-07-28 migration-drift
-- reconciliation (Task 4). Confirmed via Supabase MCP list_migrations that
-- this file's version was never recorded in supabase_migrations.schema_migrations,
-- and via live schema introspection (information_schema.tables/columns,
-- pg_proc, pg_indexes) that every table/column/index/function/policy this
-- file targets already exists in the live database — applied under a
-- different, real-timestamped migration that superseded this draft. Kept
-- for historical reference only; do not run.
-- ---------------------------------------------------------------------------

-- property_assets.replaced_by_asset_id had no ON DELETE clause (defaults to
-- RESTRICT), so deleting a replacement asset would error instead of nulling
-- out the pointer on the asset it superseded. Not a tenant-isolation issue,
-- just a lifecycle footgun.

ALTER TABLE public.property_assets
  DROP CONSTRAINT IF EXISTS property_assets_replaced_by_asset_id_fkey;

ALTER TABLE public.property_assets
  ADD CONSTRAINT property_assets_replaced_by_asset_id_fkey
  FOREIGN KEY (replaced_by_asset_id) REFERENCES public.property_assets(id) ON DELETE SET NULL;
