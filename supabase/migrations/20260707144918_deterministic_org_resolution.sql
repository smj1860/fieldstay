-- store_integration_token() resolves org_id for a brand-new connection via
-- `SELECT org_id FROM organization_members WHERE user_id = p_user_id LIMIT 1`
-- with no ORDER BY and no invite_accepted_at filter. For a user belonging to
-- more than one org (or with a pending, unaccepted invite row), which org a
-- new integration connection gets attributed to is nondeterministic — a real
-- multi-tenant correctness risk. Make it deterministic and restrict to
-- accepted memberships, matching the backfill pattern already used in
-- integration_connections_org_ownership.

CREATE OR REPLACE FUNCTION public.store_integration_token(
  p_user_id           uuid,
  p_provider_id       text,
  p_access_token      text,
  p_external_user_id  text,
  p_scope             text DEFAULT NULL::text,
  p_metadata          jsonb DEFAULT '{}'::jsonb
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
    AND invite_accepted_at IS NOT NULL
  ORDER BY created_at ASC
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
