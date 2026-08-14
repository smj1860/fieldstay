-- replaceAsset becomes one transaction, same reasoning as
-- remove_crew_from_turnover_rpc.sql: creating the new asset and marking the
-- old one replaced were two separate client-side writes, so a crash or
-- request failure between them could create the new asset without ever
-- linking the old one — corrupting the exact age-at-replacement data this
-- whole feature exists to capture (see 20260814130000's header comment).
--
-- The row lock on the OLD asset is what makes "replace" safe against a
-- double-submit or two concurrent replace attempts: the second call sees
-- replaced_by_asset_id already set (or is_active already false) and returns
-- a typed failure instead of creating a second replacement.
--
-- Grants: authenticated (called from a normal RLS-scoped server action,
-- same as remove_crew_from_turnover) plus service_role. SECURITY DEFINER
-- means RLS does not apply inside the body, so the explicit org_id checks
-- below ARE the tenant boundary — the caller passes membership.org_id from
-- requireOrgRole(), never a client-supplied value.
--
-- health_score/macrs_class in p_new_asset are computed in TypeScript
-- (calculateHealthScoreBreakdown / asset_type_standards.macrs_class_default)
-- rather than duplicated in PL/pgSQL, matching how createAsset already
-- computes them — this RPC's only job is making the two writes atomic, not
-- re-implementing business logic that already exists in one place.
CREATE OR REPLACE FUNCTION public.replace_property_asset(
  p_org_id       uuid,
  p_old_asset_id uuid,
  p_new_asset    jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_active  boolean;
  v_now         timestamptz := now();
  v_health      smallint := (p_new_asset->>'health_score')::smallint;
  v_new_id      uuid;
BEGIN
  -- Lock the old asset: this is what serialises a concurrent double-replace,
  -- so the "already replaced" check below cannot straddle another
  -- transaction's write.
  SELECT is_active AND replaced_by_asset_id IS NULL INTO v_old_active
    FROM public.property_assets
   WHERE id = p_old_asset_id
     AND org_id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'asset_not_found');
  END IF;

  IF NOT v_old_active THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_replaced_or_inactive');
  END IF;

  INSERT INTO public.property_assets (
    org_id, property_id, name, asset_type, make, model, serial_number,
    installation_date, placed_in_service_date, purchase_price,
    estimated_replacement_cost, expected_lifespan_years,
    warranty_expiry_date, warranty_provider, notes,
    health_score, health_score_updated_at, macrs_class,
    depreciation_method, salvage_value
  ) VALUES (
    p_org_id,
    (p_new_asset->>'property_id')::uuid,
    p_new_asset->>'name',
    (p_new_asset->>'asset_type')::asset_type,
    p_new_asset->>'make',
    p_new_asset->>'model',
    p_new_asset->>'serial_number',
    (p_new_asset->>'installation_date')::date,
    (p_new_asset->>'installation_date')::date,
    (p_new_asset->>'purchase_price')::numeric,
    (p_new_asset->>'estimated_replacement_cost')::numeric,
    (p_new_asset->>'expected_lifespan_years')::int,
    (p_new_asset->>'warranty_expiry_date')::date,
    p_new_asset->>'warranty_provider',
    p_new_asset->>'notes',
    v_health,
    CASE WHEN v_health IS NOT NULL THEN v_now ELSE NULL END,
    COALESCE(p_new_asset->>'macrs_class', '5_year')::macrs_class,
    'macrs',
    0
  )
  RETURNING id INTO v_new_id;

  UPDATE public.property_assets
     SET is_active            = false,
         replaced_by_asset_id = v_new_id,
         replaced_at          = v_now
   WHERE id = p_old_asset_id
     AND org_id = p_org_id;

  RETURN jsonb_build_object('ok', true, 'new_asset_id', v_new_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_property_asset(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.replace_property_asset(uuid, uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
