-- ============================================================================
-- BLOCKER: a `viewer` can read and overwrite decrypted door codes.
--
-- store_property_door_code / read_property_door_code are SECURITY DEFINER with
-- EXECUTE granted to `authenticated` (property-edit Server Actions call them
-- through the RLS-scoped client). Because RLS does not apply inside a SECURITY
-- DEFINER body, the function itself is the only authorization boundary — and
-- its guard was plain org MEMBERSHIP:
--
--   IF auth.role() <> 'service_role'
--      AND p_org_id NOT IN (SELECT get_user_org_ids()) THEN ...
--
-- get_user_org_ids() returns every org the caller belongs to in ANY role, so a
-- `viewer` (or `crew`) passed it. Meanwhile the properties_update RLS policy is
--   is_org_member(org_id, ARRAY['admin','manager'])
-- so the surrounding property UPDATE silently matched 0 rows (0 rows is NOT an
-- error) while the RPC succeeded — a viewer could overwrite a physical-access
-- credential, and read the decrypted one back.
--
-- Tighten both guards to the same role set the table's own write policy uses.
-- is_org_member() passes `owner` automatically, so owner/admin/manager keep
-- access and viewer/crew lose it. The service_role short-circuit is unchanged:
-- Inngest (guidebook door-code SMS) and webhooks have no auth.uid() to check.
--
-- Function bodies below are reproduced verbatim from the live definitions in
-- project vpmznjktllhmmbfnxuvk (read via pg_get_functiondef); only the guard
-- predicate differs.
-- ============================================================================

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
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'Access denied: caller may not manage door codes for org %', p_org_id
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
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'Access denied: caller may not read door codes for org %', p_org_id
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

-- Grants restated (unchanged from 20260714224719): `authenticated` keeps
-- EXECUTE because the Server Actions call these through the RLS-scoped
-- client — the role check now lives in the body above.
REVOKE EXECUTE ON FUNCTION public.store_property_door_code(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.store_property_door_code(uuid, uuid, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.read_property_door_code(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.read_property_door_code(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
