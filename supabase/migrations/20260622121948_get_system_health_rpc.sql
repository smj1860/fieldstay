
-- Service-role-only RPC exposing Postgres/PowerSync replication health.
-- SECURITY DEFINER is required because pg_stat_activity/pg_replication_slots
-- are restricted system catalogs that anon/authenticated cannot read
-- directly on Supabase's managed Postgres. Locked down immediately below
-- to service_role only — this exposes server topology (connection states,
-- replication lag) that must never reach the client.
CREATE OR REPLACE FUNCTION public.get_system_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'connections', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('state', state, 'count', cnt)), '[]'::jsonb)
      FROM (
        SELECT state, count(*) AS cnt
        FROM pg_stat_activity
        WHERE datname = current_database()
        GROUP BY state
      ) s
    ),
    'replication_slots', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'slot_name',  slot_name,
        'active',     active,
        'lag_bytes',  pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)
      )), '[]'::jsonb)
      FROM pg_replication_slots
      WHERE slot_type = 'logical'
    ),
    'checked_at', now()
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_system_health() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_system_health() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_system_health() TO service_role;
