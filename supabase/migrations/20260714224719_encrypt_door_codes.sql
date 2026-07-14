-- Encrypts door codes at rest via Supabase Vault, replacing the plaintext
-- properties.door_code / bookings.door_code columns. A door code is a
-- physical-access credential — the same class of secret as the OAuth
-- tokens already Vault-protected in integration_connections.

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS door_code_secret_id uuid;
ALTER TABLE bookings   ADD COLUMN IF NOT EXISTS door_code_secret_id uuid;

-- Migrate any existing plaintext door codes into Vault before dropping the
-- plaintext columns. (bookings.door_code has zero populated rows today —
-- no OwnerRez integration writes it yet — but converted for consistency
-- before any future integration work starts writing it in plaintext.)
DO $$
DECLARE
  r RECORD;
  v_secret_id uuid;
BEGIN
  FOR r IN SELECT id, door_code FROM properties WHERE door_code IS NOT NULL LOOP
    v_secret_id := vault.create_secret(
      r.door_code,
      'property_door_code_' || r.id::text,
      'Door code for property ' || r.id::text
    );
    UPDATE properties SET door_code_secret_id = v_secret_id WHERE id = r.id;
  END LOOP;

  FOR r IN SELECT id, door_code FROM bookings WHERE door_code IS NOT NULL LOOP
    v_secret_id := vault.create_secret(
      r.door_code,
      'booking_door_code_' || r.id::text,
      'Door code for booking ' || r.id::text
    );
    UPDATE bookings SET door_code_secret_id = v_secret_id WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE properties DROP COLUMN IF EXISTS door_code;
ALTER TABLE bookings   DROP COLUMN IF EXISTS door_code;

-- ── Vault wrapper RPCs ────────────────────────────────────────────────────
-- Mirrors store_integration_token/read_integration_token. Granted to
-- `authenticated` (not just service_role) because property-edit Server
-- Actions call these via the RLS-scoped client, same as
-- replace_master_checklist_items — the function itself enforces the
-- org-membership check via get_user_org_ids() since RLS doesn't apply
-- inside a SECURITY DEFINER function body. Calls made with the
-- service_role key (Inngest, webhooks) skip that check since there is no
-- auth.uid() to check against.

CREATE OR REPLACE FUNCTION public.store_property_door_code(
  p_property_id uuid,
  p_org_id      uuid,
  p_door_code   text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_existing_secret_id uuid;
  v_secret_id           uuid;
BEGIN
  IF auth.role() <> 'service_role' AND p_org_id NOT IN (SELECT get_user_org_ids()) THEN
    RAISE EXCEPTION 'Access denied: caller is not a member of org %', p_org_id
      USING ERRCODE = '42501';
  END IF;

  SELECT door_code_secret_id INTO v_existing_secret_id
  FROM public.properties
  WHERE id = p_property_id AND org_id = p_org_id;

  IF p_door_code IS NULL THEN
    IF v_existing_secret_id IS NOT NULL THEN
      DELETE FROM vault.secrets WHERE id = v_existing_secret_id;
    END IF;
    UPDATE public.properties SET door_code_secret_id = NULL
    WHERE id = p_property_id AND org_id = p_org_id;
    RETURN NULL;
  END IF;

  IF v_existing_secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_secret_id, p_door_code);
    v_secret_id := v_existing_secret_id;
  ELSE
    v_secret_id := vault.create_secret(
      p_door_code,
      'property_door_code_' || p_property_id::text,
      'Door code for property ' || p_property_id::text
    );
    UPDATE public.properties SET door_code_secret_id = v_secret_id
    WHERE id = p_property_id AND org_id = p_org_id;
  END IF;

  RETURN v_secret_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.read_property_door_code(
  p_property_id uuid,
  p_org_id      uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret_id uuid;
  v_code      text;
BEGIN
  IF auth.role() <> 'service_role' AND p_org_id NOT IN (SELECT get_user_org_ids()) THEN
    RAISE EXCEPTION 'Access denied: caller is not a member of org %', p_org_id
      USING ERRCODE = '42501';
  END IF;

  SELECT door_code_secret_id INTO v_secret_id
  FROM public.properties
  WHERE id = p_property_id AND org_id = p_org_id;

  IF v_secret_id IS NULL THEN RETURN NULL; END IF;

  SELECT decrypted_secret INTO v_code FROM vault.decrypted_secrets WHERE id = v_secret_id;
  RETURN v_code;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.store_property_door_code(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.store_property_door_code(uuid, uuid, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.read_property_door_code(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.read_property_door_code(uuid, uuid) TO authenticated, service_role;
