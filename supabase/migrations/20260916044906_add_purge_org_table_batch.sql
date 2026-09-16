-- 20260916044906_add_purge_org_table_batch.sql
-- ============================================================================
-- purge_org_table_batch(): bounded, resumable per-table purge for account
-- deletion (lib/inngest/functions/account-deletion.ts).
--
-- WHY: each of account-deletion's explicit per-table purges was one
-- indivisible `DELETE FROM t WHERE org_id = $1`, issued through PostgREST.
-- Past the Inngest step budget (~300s), Postgres rolls back the WHOLE
-- statement, and a retry re-issues the identical statement against the
-- unreduced row count — a table that has ever grown past what one statement
-- can clear in the budget can never finish purging, no matter how many
-- retries Inngest gives it.
--
-- This RPC deletes at most p_batch_size rows per call and returns how many
-- rows it actually removed, so the Inngest function loops — one step.run per
-- batch, each independently retryable — until a call reports 0. That is the
-- same resumable-batch shape lib/inngest/paginate.ts's fetchAllRows() uses
-- for reads, applied to a write.
--
-- ctid-scoped, not id-scoped: a single generic subquery-and-delete shape that
-- works identically for every allow-listed table regardless of its primary
-- key column name, with no per-table special-casing to keep in sync.
--
-- SECURITY DEFINER because the only caller is an Inngest step already
-- running under createServiceClient() (full service-role authority) — this
-- function exists to make that authority's DELETE bounded, not to grant new
-- privilege. p_table_name is validated against a hardcoded allow-list INSIDE
-- the function body and never trusted as-is: the allow-list is exactly
-- account-deletion.ts's explicit purge set (ORG_TABLES_BLOCKING_CASCADE plus
-- ORG_TABLES_WITHOUT_CASCADE), so this cannot become a general "delete any
-- table by org_id" primitive reachable from a less-trusted caller, and
-- extending it to a new table means editing this list deliberately, not
-- passing a new string through from the caller.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.purge_org_table_batch(
  p_table_name text,
  p_org_id     uuid,
  p_batch_size int DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_batch_size < 1 OR p_batch_size > 20000 THEN
    RAISE EXCEPTION 'purge_org_table_batch: p_batch_size must be between 1 and 20000, got %', p_batch_size;
  END IF;

  -- Allow-list, not string-interpolated trust. Every table
  -- account-deletion.ts purges explicitly today, and nothing else.
  IF p_table_name NOT IN (
    'work_order_invoices',
    'owner_transactions',
    'purchase_orders',
    'work_orders',
    'asset_depreciation_entries',
    'assignment_outcomes',
    'vendor_assignment_outcomes',
    'crew_availability',
    'inventory_templates',
    'maintenance_schedule_templates',
    'messages'
  ) THEN
    RAISE EXCEPTION 'purge_org_table_batch: % is not an allow-listed purge target', p_table_name;
  END IF;

  EXECUTE format(
    'DELETE FROM public.%I WHERE ctid IN (SELECT ctid FROM public.%I WHERE org_id = $1 LIMIT $2)',
    p_table_name, p_table_name
  ) USING p_org_id, p_batch_size;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- Never runnable from a browser session or a lower-trust role — the caller is
-- always an Inngest step under createServiceClient({ system: '...' }).
REVOKE ALL ON FUNCTION public.purge_org_table_batch(text, uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_org_table_batch(text, uuid, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_org_table_batch(text, uuid, int) TO service_role;
