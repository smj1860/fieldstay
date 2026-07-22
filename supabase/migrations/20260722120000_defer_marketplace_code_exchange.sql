-- Defer marketplace OAuth token exchange until after signup.
--
-- Hospitable's partner team reported (2026-07-22) that clicking "Get Started"
-- on their marketplace flips the user to "Connected" on Hospitable's side
-- before the user has a FieldStay account. Root cause: the one-click callback
-- (and the standard callback's no-session branch) exchanged the authorization
-- code for tokens IMMEDIATELY on arrival, then held the exchanged tokens in
-- pending_integration_links while the user signed up. The token exchange
-- itself is what registers the connection with the provider — so an abandoned
-- signup left the provider showing "Connected" forever, with a live refresh
-- token sitting in an expired pending row we never revoke.
--
-- New model: hold the UNEXCHANGED authorization code (Vault-backed, single-use,
-- 30 min TTL) and perform the code→token exchange in /connect/finish, after
-- requireAuth() — so nothing is ever registered with the provider until a real
-- FieldStay account exists to attach it to. If the code has expired by claim
-- time (provider codes are typically single-use and short-lived), the route
-- falls back to restarting the standard /connect flow — the user is
-- authenticated at that point and the provider auto-approves an
-- already-granted app, so recovery is a single redirect bounce.
--
-- The legacy exchanged-token holding area (pending_integration_links +
-- create_pending_integration_link/claim_pending_integration_link) is no
-- longer called by app code as of the commit that ships this migration. The
-- DB objects are intentionally kept for the deploy window (in-flight pending
-- links created by the previous code remain claimable for their 30 min TTL
-- via the old claim path's graceful-expiry branch) — drop them in a follow-up
-- migration once this deploy has settled.

CREATE TABLE IF NOT EXISTS public.pending_oauth_authorizations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_link_token   text        NOT NULL UNIQUE,
  provider_id          text        NOT NULL REFERENCES public.integration_providers(id) ON DELETE CASCADE,
  code_vault_secret_id uuid        NOT NULL,
  -- The redirect_uri the authorization request was issued against. Must be
  -- replayed verbatim on the deferred exchange for providers that enforce it
  -- (inert for Hospitable, whose redirect_uri is portal-configured).
  redirect_uri         text        NOT NULL,
  expires_at           timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_oauth_authorizations_expires_at
  ON public.pending_oauth_authorizations (expires_at);

ALTER TABLE public.pending_oauth_authorizations ENABLE ROW LEVEL SECURITY;
-- Service-role only, same as oauth_states/pending_integration_links — no
-- policies by design.

COMMENT ON TABLE public.pending_oauth_authorizations IS
  'Short-lived holding area for UNEXCHANGED OAuth authorization codes from '
  'marketplace installs, before the FieldStay account exists. The code→token '
  'exchange is deferred to /connect/finish (post-auth) so the provider never '
  'registers a connection for a user who has not signed up. RLS enabled, no '
  'policies — service_role only. TTL 30 minutes via '
  'cleanup_expired_pending_oauth_authorizations().';

REVOKE ALL ON public.pending_oauth_authorizations FROM PUBLIC;
GRANT  ALL ON public.pending_oauth_authorizations TO service_role;

-- ── create_pending_oauth_authorization() ─────────────────────────────────────
-- Stores the raw authorization code in Vault (it is a credential — same
-- zero-plaintext-at-rest rule as tokens) and records a claimable pending row.
CREATE OR REPLACE FUNCTION public.create_pending_oauth_authorization(
  p_pending_link_token text,
  p_provider_id        text,
  p_authorization_code text,
  p_redirect_uri       text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_code_secret_id uuid;
  v_id             uuid;
BEGIN
  v_code_secret_id := vault.create_secret(
    p_authorization_code,
    p_provider_id || '_pending_code_' || p_pending_link_token,
    'Pending OAuth authorization code for ' || p_provider_id || ' (marketplace install, unexchanged)'
  );

  INSERT INTO public.pending_oauth_authorizations
    (pending_link_token, provider_id, code_vault_secret_id, redirect_uri)
  VALUES
    (p_pending_link_token, p_provider_id, v_code_secret_id, p_redirect_uri)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL     ON FUNCTION public.create_pending_oauth_authorization FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_pending_oauth_authorization TO service_role;

-- ── claim_pending_oauth_authorization() ──────────────────────────────────────
-- Called from /connect/finish once the user has a real, authenticated
-- FieldStay session. Returns the decrypted code + the redirect_uri to replay
-- on the exchange. Single-use: the Vault secret and the pending row are
-- destroyed inside the same transaction, before the code is returned — a
-- second claim of the same token finds no row and returns empty. FOR UPDATE
-- serializes two concurrent claims of the same token (TOCTOU guard).
CREATE OR REPLACE FUNCTION public.claim_pending_oauth_authorization(
  p_pending_link_token text
)
RETURNS TABLE(provider_id text, authorization_code text, redirect_uri text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_pending public.pending_oauth_authorizations%ROWTYPE;
  v_code    text;
BEGIN
  SELECT * INTO v_pending
  FROM public.pending_oauth_authorizations
  WHERE pending_link_token = p_pending_link_token
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT ds.decrypted_secret INTO v_code
  FROM vault.decrypted_secrets ds
  WHERE ds.id = v_pending.code_vault_secret_id;

  DELETE FROM vault.secrets WHERE id = v_pending.code_vault_secret_id;
  DELETE FROM public.pending_oauth_authorizations WHERE id = v_pending.id;

  RETURN QUERY SELECT v_pending.provider_id, v_code, v_pending.redirect_uri;
END;
$function$;

REVOKE ALL     ON FUNCTION public.claim_pending_oauth_authorization FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_pending_oauth_authorization TO service_role;

-- ── cleanup_expired_pending_oauth_authorizations() ───────────────────────────
-- Deletes stale, never-claimed pending codes (and their Vault secrets) past
-- their TTL. Invoked probabilistically from the integration routes (same
-- fire-on-request pattern as cleanup_webhook_dedup()) — an expired code is
-- worthless to an attacker (single-use, short provider-side lifetime), so
-- this is hygiene, not a security control.
CREATE OR REPLACE FUNCTION public.cleanup_expired_pending_oauth_authorizations()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, code_vault_secret_id
    FROM public.pending_oauth_authorizations
    WHERE expires_at < now()
  LOOP
    DELETE FROM vault.secrets WHERE id = r.code_vault_secret_id;
    DELETE FROM public.pending_oauth_authorizations WHERE id = r.id;
  END LOOP;
END;
$function$;

REVOKE ALL     ON FUNCTION public.cleanup_expired_pending_oauth_authorizations() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cleanup_expired_pending_oauth_authorizations() TO service_role;

NOTIFY pgrst, 'reload schema';
