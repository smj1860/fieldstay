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
-- Audit event retention policy enforcement
--
-- Financial actions (billing.*, owner.transaction.*) are kept 7 years per
-- IRS Rev. Proc. 98-25 and GAAP requirements.
-- All other audit events are kept 3 years (SOC2 Type II minimum + GDPR
-- "reasonable period" for security/access logs).
--
-- Called monthly by the Inngest audit-retention cron.

CREATE OR REPLACE FUNCTION purge_expired_audit_events()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_financial_cutoff    timestamptz := NOW() - INTERVAL '7 years';
  v_operational_cutoff  timestamptz := NOW() - INTERVAL '3 years';
  v_financial_deleted   integer;
  v_operational_deleted integer;
BEGIN
  -- Financial records: billing and owner transaction audit events (7-year IRS/GAAP retention)
  DELETE FROM audit_events
  WHERE created_at < v_financial_cutoff
    AND (action LIKE 'billing.%' OR action LIKE 'owner.transaction.%');
  GET DIAGNOSTICS v_financial_deleted = ROW_COUNT;

  -- Operational records: all other audit events (3-year SOC2/GDPR retention)
  DELETE FROM audit_events
  WHERE created_at < v_operational_cutoff
    AND action NOT LIKE 'billing.%'
    AND action NOT LIKE 'owner.transaction.%';
  GET DIAGNOSTICS v_operational_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'financial_deleted',   v_financial_deleted,
    'operational_deleted', v_operational_deleted,
    'run_at',              NOW()
  );
END;
$$;

-- Grant execution only to the service role (used by Inngest cron steps)
GRANT EXECUTE ON FUNCTION purge_expired_audit_events() TO service_role;
REVOKE EXECUTE ON FUNCTION purge_expired_audit_events() FROM PUBLIC;
