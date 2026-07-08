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
-- Vault-backed storage for OAuth refresh tokens, mirroring
-- store_integration_token / read_integration_token (access tokens).
-- Used by providers whose access tokens expire (e.g. Kroger).
-- OwnerRez tokens never expire and never call these.

CREATE OR REPLACE FUNCTION public.store_integration_refresh_token(
  p_user_id     uuid,
  p_provider_id text,
  p_refresh_token text,
  p_expires_at  timestamptz DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_secret_id          uuid;
  v_existing_secret_id uuid;
BEGIN
  SELECT refresh_token_vault_secret_id
    INTO v_existing_secret_id
  FROM public.integration_connections
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  IF v_existing_secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_secret_id, p_refresh_token);
    v_secret_id := v_existing_secret_id;
  ELSE
    v_secret_id := vault.create_secret(
      p_refresh_token,
      p_provider_id || '_refresh_' || p_user_id::text,
      'OAuth refresh token for ' || p_provider_id
    );
  END IF;

  UPDATE public.integration_connections
  SET refresh_token_vault_secret_id = v_secret_id,
      expires_at                    = p_expires_at,
      updated_at                    = now()
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  RETURN v_secret_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.read_integration_refresh_token(p_user_id uuid, p_provider_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_token text;
BEGIN
  SELECT ds.decrypted_secret
    INTO v_token
  FROM public.integration_connections c
  JOIN vault.decrypted_secrets ds ON ds.id = c.refresh_token_vault_secret_id
  WHERE c.user_id     = p_user_id
    AND c.provider_id = p_provider_id
    AND c.status      = 'active';

  RETURN v_token;
END;
$function$;

-- Extend revoke_integration_token to also destroy the refresh-token secret
-- (added by store_integration_refresh_token above), which the original
-- definition didn't know about.
CREATE OR REPLACE FUNCTION public.revoke_integration_token(p_user_id uuid, p_provider_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_secret_id         uuid;
  v_refresh_secret_id uuid;
BEGIN
  SELECT vault_secret_id, refresh_token_vault_secret_id
    INTO v_secret_id, v_refresh_secret_id
  FROM public.integration_connections
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  UPDATE public.integration_connections
  SET status                        = 'revoked',
      vault_secret_id               = NULL,
      refresh_token_vault_secret_id = NULL,
      expires_at                    = NULL,
      updated_at                    = now()
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  IF v_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret_id;
  END IF;

  IF v_refresh_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_refresh_secret_id;
  END IF;
END;
$function$;
