-- Marketplace one-click install: a user arriving from a provider's marketplace
-- (e.g. "Connect FieldStay" inside OwnerRez) may hit /api/integrations/[provider]/callback
-- with a valid, already-exchanged access token but no FieldStay session and no
-- existing account. Previously that token was discarded and the user was sent
-- to /signup to restart the OAuth flow from scratch after creating an account —
-- wasteful (a valid token thrown away) and fragile (a second manual reconnect
-- step). This migration adds a short-lived, Vault-backed holding area so the
-- already-obtained token can be claimed once signup completes, with zero
-- plaintext tokens at rest (mirrors the pattern in store_integration_token).

CREATE TABLE IF NOT EXISTS public.pending_integration_links (
  id                             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_link_token             text        NOT NULL UNIQUE,
  provider_id                    text        NOT NULL REFERENCES public.integration_providers(id),
  external_user_id               text        NOT NULL,
  vault_secret_id                uuid        NOT NULL,
  refresh_token_vault_secret_id  uuid,
  scope                          text,
  metadata                       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  expires_at                     timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  created_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_integration_links_expires_at
  ON public.pending_integration_links (expires_at);

ALTER TABLE public.pending_integration_links ENABLE ROW LEVEL SECURITY;
-- Service-role only, same as oauth_states — no policies by design.

COMMENT ON TABLE public.pending_integration_links IS
  'Short-lived holding area for OAuth tokens exchanged during a marketplace '
  'install before the FieldStay account exists. RLS enabled, no policies — '
  'service_role only (integration callback + claim routes). TTL 30 minutes '
  'via cleanup_expired_pending_integration_links().';

REVOKE ALL ON public.pending_integration_links FROM PUBLIC;
GRANT  ALL ON public.pending_integration_links TO service_role;

-- ── create_pending_integration_link() ────────────────────────────────────────
-- Stores the already-exchanged token in Vault and records a claimable pending
-- row. Mirrors store_integration_token()'s Vault-secret-creation pattern.
CREATE OR REPLACE FUNCTION public.create_pending_integration_link(
  p_pending_link_token  text,
  p_provider_id         text,
  p_external_user_id    text,
  p_access_token        text,
  p_refresh_token       text DEFAULT NULL,
  p_scope               text DEFAULT NULL,
  p_metadata             jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_access_secret_id  uuid;
  v_refresh_secret_id uuid;
  v_id                uuid;
BEGIN
  v_access_secret_id := vault.create_secret(
    p_access_token,
    p_provider_id || '_pending_token_' || p_pending_link_token,
    'Pending OAuth access token for ' || p_provider_id || ' (marketplace install, unclaimed)'
  );

  IF p_refresh_token IS NOT NULL THEN
    v_refresh_secret_id := vault.create_secret(
      p_refresh_token,
      p_provider_id || '_pending_refresh_' || p_pending_link_token,
      'Pending OAuth refresh token for ' || p_provider_id || ' (marketplace install, unclaimed)'
    );
  END IF;

  INSERT INTO public.pending_integration_links
    (pending_link_token, provider_id, external_user_id, vault_secret_id, refresh_token_vault_secret_id, scope, metadata)
  VALUES
    (p_pending_link_token, p_provider_id, p_external_user_id, v_access_secret_id, v_refresh_secret_id, p_scope, p_metadata)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL     ON FUNCTION public.create_pending_integration_link FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_pending_integration_link TO service_role;

-- ── claim_pending_integration_link() ─────────────────────────────────────────
-- Called once the user has a real FieldStay session. Re-points the already-
-- encrypted Vault secret at a normal integration_connections row for that
-- user — no decrypt/re-encrypt round trip needed, since a Vault secret isn't
-- tied to any particular consumer row. Single-use: the pending row is deleted
-- on claim. Org resolution mirrors store_integration_token()'s deterministic
-- earliest-accepted-membership rule; if the user hasn't completed onboarding
-- (no org yet), org_id is left null, same as a normal connect attempt would
-- produce in that situation.
CREATE OR REPLACE FUNCTION public.claim_pending_integration_link(
  p_pending_link_token text,
  p_user_id            uuid
)
RETURNS TABLE(provider_id text, external_user_id text, org_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pending  public.pending_integration_links%ROWTYPE;
  v_org_id   uuid;
BEGIN
  SELECT * INTO v_pending
  FROM public.pending_integration_links
  WHERE pending_link_token = p_pending_link_token
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT om.org_id INTO v_org_id
  FROM public.organization_members om
  WHERE om.user_id = p_user_id
    AND om.invite_accepted_at IS NOT NULL
  ORDER BY om.created_at ASC
  LIMIT 1;

  INSERT INTO public.integration_connections
    (user_id, org_id, provider_id, external_user_id, vault_secret_id, refresh_token_vault_secret_id, scope, metadata, status)
  VALUES
    (p_user_id, v_org_id, v_pending.provider_id, v_pending.external_user_id, v_pending.vault_secret_id,
     v_pending.refresh_token_vault_secret_id, v_pending.scope, v_pending.metadata, 'active')
  ON CONFLICT (user_id, provider_id) DO UPDATE
  SET vault_secret_id                = EXCLUDED.vault_secret_id,
      refresh_token_vault_secret_id  = EXCLUDED.refresh_token_vault_secret_id,
      external_user_id               = EXCLUDED.external_user_id,
      scope                          = EXCLUDED.scope,
      metadata                       = EXCLUDED.metadata,
      status                         = 'active',
      org_id                         = COALESCE(public.integration_connections.org_id, EXCLUDED.org_id),
      reconnect_email_sent_at        = NULL,
      updated_at                     = now();

  DELETE FROM public.pending_integration_links WHERE id = v_pending.id;

  RETURN QUERY SELECT v_pending.provider_id, v_pending.external_user_id, v_org_id;
END;
$function$;

REVOKE ALL     ON FUNCTION public.claim_pending_integration_link FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_pending_integration_link TO service_role;

-- ── cleanup_expired_pending_integration_links() ──────────────────────────────
-- Deletes stale, never-claimed pending links (and their orphaned Vault
-- secrets) past their TTL. Mirrors cleanup_webhook_dedup()'s probabilistic
-- fire-on-request pattern rather than a dedicated cron.
CREATE OR REPLACE FUNCTION public.cleanup_expired_pending_integration_links()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, vault_secret_id, refresh_token_vault_secret_id
    FROM public.pending_integration_links
    WHERE expires_at < now()
  LOOP
    DELETE FROM vault.secrets WHERE id = r.vault_secret_id;
    IF r.refresh_token_vault_secret_id IS NOT NULL THEN
      DELETE FROM vault.secrets WHERE id = r.refresh_token_vault_secret_id;
    END IF;
    DELETE FROM public.pending_integration_links WHERE id = r.id;
  END LOOP;
END;
$function$;

REVOKE ALL     ON FUNCTION public.cleanup_expired_pending_integration_links() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cleanup_expired_pending_integration_links() TO service_role;

NOTIFY pgrst, 'reload schema';
