-- claim_pending_integration_link()'s ON CONFLICT DO UPDATE overwrites an
-- existing connection's vault_secret_id/refresh_token_vault_secret_id with
-- the pending link's secrets (different Vault rows, named
-- '<provider>_pending_token_<link_token>' rather than
-- '<provider>_token_<user_id>'), but never deletes the secrets it just
-- replaced — same orphan-leaves-a-live-credential-behind class of bug as
-- store_integration_token's pre-fix behavior, just via UPDATE instead of a
-- failed INSERT. Capture the old secret ids before the upsert and delete
-- them after, and take the same per-(user, provider) advisory lock
-- store_integration_token now uses so the two entry points can't race.

CREATE OR REPLACE FUNCTION public.claim_pending_integration_link(
  p_pending_link_token text,
  p_user_id            uuid
)
RETURNS TABLE(provider_id text, external_user_id text, org_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_pending            public.pending_integration_links%ROWTYPE;
  v_org_id             uuid;
  v_old_secret_id      uuid;
  v_old_refresh_secret_id uuid;
BEGIN
  SELECT * INTO v_pending
  FROM public.pending_integration_links
  WHERE pending_link_token = p_pending_link_token
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('integration_connection:' || p_user_id::text || ':' || v_pending.provider_id, 0));

  SELECT om.org_id INTO v_org_id
  FROM public.organization_members om
  WHERE om.user_id = p_user_id
    AND om.invite_accepted_at IS NOT NULL
  ORDER BY om.created_at ASC
  LIMIT 1;

  -- Capture whatever secrets an existing connection row currently points at,
  -- before the upsert below overwrites those columns with the pending link's.
  SELECT vault_secret_id, refresh_token_vault_secret_id
    INTO v_old_secret_id, v_old_refresh_secret_id
  FROM public.integration_connections
  WHERE user_id = p_user_id AND provider_id = v_pending.provider_id;

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

  -- Now safe to delete the superseded secrets — the row no longer references them.
  IF v_old_secret_id IS NOT NULL AND v_old_secret_id IS DISTINCT FROM v_pending.vault_secret_id THEN
    DELETE FROM vault.secrets WHERE id = v_old_secret_id;
  END IF;
  IF v_old_refresh_secret_id IS NOT NULL AND v_old_refresh_secret_id IS DISTINCT FROM v_pending.refresh_token_vault_secret_id THEN
    DELETE FROM vault.secrets WHERE id = v_old_refresh_secret_id;
  END IF;

  DELETE FROM public.pending_integration_links WHERE id = v_pending.id;

  RETURN QUERY SELECT v_pending.provider_id, v_pending.external_user_id, v_org_id;
END;
$function$;

REVOKE ALL     ON FUNCTION public.claim_pending_integration_link FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_pending_integration_link TO service_role;

NOTIFY pgrst, 'reload schema';
