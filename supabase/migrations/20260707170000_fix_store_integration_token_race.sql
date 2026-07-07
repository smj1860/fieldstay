-- store_integration_token() and store_integration_refresh_token() each do a
-- plain SELECT to check for an existing connection, then conditionally call
-- vault.create_secret() with a name derived only from (provider_id, user_id).
-- Two overlapping calls for the same (user, provider) — e.g. a duplicated
-- OAuth callback delivery — can both see "no existing connection" and both
-- call vault.create_secret() with the identical name. The loser crashes with
-- "duplicate key value violates unique constraint secrets_name_idx", which
-- surfaces to the user as "storage_failed" even though the other call's
-- connection succeeded. Serialize with a per-(user, provider) advisory
-- transaction lock so the second caller waits and takes the update path
-- against the row the first caller just committed, instead of racing it.

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
  PERFORM pg_advisory_xact_lock(hashtextextended('integration_connection:' || p_user_id::text || ':' || p_provider_id, 0));

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
  PERFORM pg_advisory_xact_lock(hashtextextended('integration_connection:' || p_user_id::text || ':' || p_provider_id, 0));

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

REVOKE ALL     ON FUNCTION public.store_integration_refresh_token FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.store_integration_refresh_token TO service_role;

NOTIFY pgrst, 'reload schema';
