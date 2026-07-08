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
-- Proactive token refresh infrastructure
--
-- 1. Add reconnect_email_sent_at to integration_connections so we send
--    exactly ONE "reconnect required" email per failure, not one per
--    cron tick, and clear it automatically the next time the connection
--    refreshes successfully.
--
-- 2. Fix store_integration_token so a token refresh (metadata: {}) no
--    longer wipes out metadata written by other steps — most importantly
--    last_sync_status, which the initial-sync jobs write into metadata
--    and the settings page polls to know a sync finished. The previous
--    UPDATE branch did `metadata = p_metadata`, unconditionally replacing
--    the whole object; a refresh right after a successful sync erased
--    last_sync_status back to unset, so the UI kept polling for a result
--    that would never arrive ("Taking longer than expected"). This
--    replaces that assignment with a jsonb merge so refresh calls that
--    pass an empty metadata object leave existing keys untouched, while
--    calls that do pass metadata (e.g. reconnect) still take effect.
--    All other logic (org_id backfill from organization_members, vault
--    secret create/update) is preserved unchanged from the live function.
-- ============================================================

-- 1. Reconnect email dedup column
ALTER TABLE public.integration_connections
  ADD COLUMN IF NOT EXISTS reconnect_email_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.integration_connections.reconnect_email_sent_at IS
  'Set when a reconnect-required email is sent to the PM after a proactive token
   refresh failure. Prevents duplicate emails on repeated refresh attempts.
   Cleared automatically the next time store_integration_token succeeds.';

-- 2. store_integration_token — merge metadata on refresh instead of replacing it
CREATE OR REPLACE FUNCTION public.store_integration_token(
  p_user_id uuid,
  p_provider_id text,
  p_access_token text,
  p_external_user_id text,
  p_scope text DEFAULT NULL::text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_secret_id          uuid;
  v_existing_secret_id uuid;
  v_connection_exists  boolean := false;
  v_org_id             uuid;
BEGIN
  SELECT org_id INTO v_org_id
  FROM public.organization_members
  WHERE user_id = p_user_id
  LIMIT 1;

  SELECT vault_secret_id, true
    INTO v_existing_secret_id, v_connection_exists
  FROM public.integration_connections
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  IF v_connection_exists THEN
    IF v_existing_secret_id IS NOT NULL THEN
      PERFORM vault.update_secret(v_existing_secret_id, p_access_token);
      v_secret_id := v_existing_secret_id;
    ELSE
      v_secret_id := vault.create_secret(
        p_access_token,
        p_provider_id || '_token_' || p_user_id::text,
        'OAuth access token for ' || p_provider_id
      );
    END IF;

    UPDATE public.integration_connections
    SET vault_secret_id         = v_secret_id,
        external_user_id        = p_external_user_id,
        scope                   = p_scope,
        metadata                = COALESCE(metadata, '{}'::jsonb) || p_metadata,
        status                  = 'active',
        org_id                  = COALESCE(org_id, v_org_id),
        reconnect_email_sent_at = NULL,
        updated_at              = now()
    WHERE user_id     = p_user_id
      AND provider_id = p_provider_id;
  ELSE
    v_secret_id := vault.create_secret(
      p_access_token,
      p_provider_id || '_token_' || p_user_id::text,
      'OAuth access token for ' || p_provider_id
    );

    INSERT INTO public.integration_connections
      (user_id, org_id, provider_id, external_user_id, vault_secret_id, scope, metadata)
    VALUES
      (p_user_id, v_org_id, p_provider_id, p_external_user_id, v_secret_id, p_scope, p_metadata);
  END IF;

  RETURN v_secret_id;
END;
$function$;

REVOKE ALL     ON FUNCTION public.store_integration_token FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.store_integration_token TO service_role;

NOTIFY pgrst, 'reload schema';
