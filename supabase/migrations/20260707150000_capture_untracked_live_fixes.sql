-- These statements were verified live in production (project vpmznjktllhmmbfnxuvk)
-- during the supabase/migrations/ reconciliation on 2026-07-07, but had NO
-- corresponding entry anywhere in supabase_migrations.schema_migrations —
-- meaning they were applied directly (e.g. via the SQL editor) outside the
-- tracked migration flow, similar to the handful of RLS helper functions that
-- also predate migration tracking. Two old, mistimed git files previously
-- claimed to cover this content (fix_api_errors.sql, property_assets_realtime.sql)
-- but neither had a matching live migration record, so their content is
-- captured here instead, verified against the live schema via direct
-- introspection (pg_publication_tables, information_schema.role_table_grants,
-- information_schema.table_constraints) before writing this file. All
-- statements are idempotent/guarded and this migration is a no-op if re-run
-- against the live project — it exists purely to close the git tracking gap.
-- This migration has NOT been applied via apply_migration; it is a git-only
-- documentation/safety-net commit.

-- Grant SELECT on vendor_compliance_status view to authenticated role
-- (underlying tables vendors + vendor_compliance_documents already have full grants)
GRANT SELECT ON public.vendor_compliance_status TO authenticated;

-- Add FK from inventory_count_drafts.submitted_by to crew_members
-- Allows PostgREST to resolve the crew_members join in inventory draft queries
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'inventory_count_drafts'
      AND constraint_name = 'inventory_count_drafts_submitted_by_fkey'
  ) THEN
    ALTER TABLE public.inventory_count_drafts
      ADD CONSTRAINT inventory_count_drafts_submitted_by_fkey
      FOREIGN KEY (submitted_by) REFERENCES public.crew_members(id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- Add property_assets to the realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'property_assets'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.property_assets;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
