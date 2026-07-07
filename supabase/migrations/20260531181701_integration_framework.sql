
-- ============================================================
-- FieldStay: Generic Multi-Integration Framework
--
-- Replaces the old org_integrations table (org-scoped,
-- plain-text credentials) with a proper architecture:
--   - User-level connections (one per user per provider)
--   - Supabase Vault for token encryption
--   - Extensible provider registry (OwnerRez, Hostaway, Guesty, ...)
--
-- Adding a new integration in the future = one new row here
-- + one new TypeScript provider adapter file. Schema never changes.
-- ============================================================

-- Drop the old org-level integration table.
-- Zero rows, wrong scope, credentials stored insecurely.
DROP TABLE IF EXISTS public.org_integrations;

-- Enable Vault (safe to run if already enabled)
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- ============================================================
-- 1. PROVIDER REGISTRY
--    One row per supported integration platform.
--    Safe to sync to clients via PowerSync (no secrets here).
-- ============================================================
CREATE TABLE public.integration_providers (
  id           text        PRIMARY KEY,
  display_name text        NOT NULL,
  auth_type    text        NOT NULL CHECK (auth_type IN ('oauth2', 'api_key')),
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed all current and planned providers upfront.
-- Adapters for Hostaway and Guesty will be built when those
-- partnerships are pursued — the DB is ready now.
INSERT INTO public.integration_providers (id, display_name, auth_type) VALUES
  ('ownerrez', 'OwnerRez', 'oauth2'),
  ('hostaway', 'Hostaway', 'oauth2'),
  ('guesty',   'Guesty',   'oauth2');

-- ============================================================
-- 2. USER CONNECTIONS
--    One row per (user, provider) pair.
--    Stores metadata ONLY. The actual token lives in Vault.
--
--    ⚠️  NEVER add this table to PowerSync sync rules.
--        It must never reach the client device.
-- ============================================================
CREATE TABLE public.integration_connections (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_id      text        NOT NULL REFERENCES public.integration_providers(id),
  external_user_id text,
  vault_secret_id  uuid,                    -- NULL when revoked (secret destroyed)
  scope            text,
  status           text        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'revoked', 'error')),
  metadata         jsonb       NOT NULL DEFAULT '{}',
  connected_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_id)
);

ALTER TABLE public.integration_connections ENABLE ROW LEVEL SECURITY;

-- Users can see whether they have a connection — never the token itself.
-- Vault secret IDs are UUIDs with no meaning outside the DB functions.
CREATE POLICY "users_view_own_connections"
  ON public.integration_connections
  FOR SELECT
  USING (auth.uid() = user_id);

-- No client-side INSERT/UPDATE/DELETE.
-- All writes go through service_role Vault wrapper functions.

-- ============================================================
-- 3. OAUTH STATE STORE
--    Short-lived CSRF protection tokens. Server-side only.
--    Consumed immediately after use, auto-expires in 10 min.
--
--    ⚠️  NEVER add this table to PowerSync sync rules.
-- ============================================================
CREATE TABLE public.oauth_states (
  state       text        PRIMARY KEY,
  user_id     uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_id text        NOT NULL,
  return_to   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + INTERVAL '10 minutes')
);

CREATE INDEX oauth_states_expires_at_idx ON public.oauth_states (expires_at);

CREATE OR REPLACE FUNCTION public.cleanup_expired_oauth_states()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  DELETE FROM public.oauth_states WHERE expires_at < now();
$$;

-- ============================================================
-- 4. VAULT WRAPPER FUNCTIONS
--    All three granted ONLY to service_role.
--    The browser (anon/authenticated) can never call them.
-- ============================================================

-- 4a. STORE (create or update) a token
CREATE OR REPLACE FUNCTION public.store_integration_token(
  p_user_id          uuid,
  p_provider_id      text,
  p_access_token     text,
  p_external_user_id text,
  p_scope            text  DEFAULT NULL,
  p_metadata         jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret_id          uuid;
  v_existing_secret_id uuid;
  v_connection_exists  boolean := false;
BEGIN
  SELECT vault_secret_id, true
    INTO v_existing_secret_id, v_connection_exists
  FROM public.integration_connections
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  IF v_connection_exists THEN
    IF v_existing_secret_id IS NOT NULL THEN
      -- Update existing Vault secret in place
      PERFORM vault.update_secret(v_existing_secret_id, p_access_token);
      v_secret_id := v_existing_secret_id;
    ELSE
      -- Previously revoked — secret was destroyed. Create a fresh one.
      v_secret_id := vault.create_secret(
        p_access_token,
        p_provider_id || '_token_' || p_user_id::text,
        'OAuth access token for ' || p_provider_id
      );
    END IF;

    UPDATE public.integration_connections
    SET vault_secret_id  = v_secret_id,
        external_user_id = p_external_user_id,
        scope            = p_scope,
        metadata         = p_metadata,
        status           = 'active',
        updated_at       = now()
    WHERE user_id     = p_user_id
      AND provider_id = p_provider_id;

  ELSE
    -- Brand new connection
    v_secret_id := vault.create_secret(
      p_access_token,
      p_provider_id || '_token_' || p_user_id::text,
      'OAuth access token for ' || p_provider_id
    );

    INSERT INTO public.integration_connections
      (user_id, provider_id, external_user_id, vault_secret_id, scope, metadata)
    VALUES
      (p_user_id, p_provider_id, p_external_user_id, v_secret_id, p_scope, p_metadata);
  END IF;

  RETURN v_secret_id;
END;
$$;

-- 4b. READ (decrypt) a token
CREATE OR REPLACE FUNCTION public.read_integration_token(
  p_user_id     uuid,
  p_provider_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_token text;
BEGIN
  SELECT ds.decrypted_secret
    INTO v_token
  FROM public.integration_connections c
  JOIN vault.decrypted_secrets ds ON ds.id = c.vault_secret_id
  WHERE c.user_id     = p_user_id
    AND c.provider_id = p_provider_id
    AND c.status      = 'active';

  IF v_token IS NOT NULL THEN
    UPDATE public.integration_connections
    SET last_used_at = now()
    WHERE user_id     = p_user_id
      AND provider_id = p_provider_id;
  END IF;

  RETURN v_token;
END;
$$;

-- 4c. REVOKE — mark revoked and destroy the Vault secret
CREATE OR REPLACE FUNCTION public.revoke_integration_token(
  p_user_id     uuid,
  p_provider_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret_id uuid;
BEGIN
  SELECT vault_secret_id
    INTO v_secret_id
  FROM public.integration_connections
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  UPDATE public.integration_connections
  SET status          = 'revoked',
      vault_secret_id = NULL,
      updated_at      = now()
  WHERE user_id     = p_user_id
    AND provider_id = p_provider_id;

  IF v_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret_id;
  END IF;
END;
$$;

-- Strip all permissions then grant service_role only
REVOKE EXECUTE ON FUNCTION public.store_integration_token(uuid, text, text, text, text, jsonb)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.store_integration_token(uuid, text, text, text, text, jsonb)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.read_integration_token(uuid, text)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.read_integration_token(uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.revoke_integration_token(uuid, text)
  FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.revoke_integration_token(uuid, text)
  TO service_role;
