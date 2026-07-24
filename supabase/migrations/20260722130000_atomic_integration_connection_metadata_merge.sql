-- ============================================================
-- Atomic JSONB merge for integration_connections.metadata.
--
-- Every OwnerRez sync path (initial-sync, incremental-sync, reviews-sync)
-- previously updated metadata with a plain SELECT -> merge in JS -> UPDATE.
-- That's a read-modify-write race: ownerrez-incremental-sync.ts's
-- check-new-properties step can re-fire integration/ownerrez.connected
-- (re-triggering initial-sync) while the current incremental-sync tick for
-- the same connection is still running. Both functions then independently
-- read, merge, and write the same metadata blob — whichever finishes last
-- wins outright and silently discards the other run's concurrent update
-- (a regressed sync_cursor, or a stale last_sync_status/last_sync_error
-- clobbering a newer one).
--
-- This function performs the merge inside a single UPDATE statement, using
-- Postgres's own row lock and the live value of `metadata` at write time
-- (`metadata || p_patch`) rather than a value read earlier in application
-- code — concurrent callers now serialize on the row lock instead of
-- racing on a stale read.
-- ============================================================

CREATE OR REPLACE FUNCTION public.merge_integration_connection_metadata(
  p_user_id     uuid,
  p_provider_id text,
  p_patch       jsonb,
  p_status      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_metadata jsonb;
BEGIN
  UPDATE public.integration_connections
  SET metadata   = COALESCE(metadata, '{}'::jsonb) || p_patch,
      status     = COALESCE(p_status, status),
      updated_at = now()
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id
  RETURNING metadata INTO v_metadata;

  RETURN v_metadata;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.merge_integration_connection_metadata(uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.merge_integration_connection_metadata(uuid, text, jsonb, text)
  TO service_role;
