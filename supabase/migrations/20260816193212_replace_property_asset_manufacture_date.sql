-- replace_property_asset() hardcodes the column list it inserts, so a field
-- added to the shared asset form was silently dropped on the REPLACE path
-- while working everywhere else. manufacture_date is that field: the nameplate
-- year now has its own input (it used to be pre-filled into Installation Date,
-- where an OCR guess became indistinguishable from a recorded date), and
-- lib/assets/age-basis.ts reads it as the last-resort basis for age, health,
-- capex and depreciation.
--
-- Replacing an asset is exactly when a PM scans a data plate — the unit is new
-- and physically in front of them — so this is the path that most needs it.
--
-- placed_in_service_date deliberately still tracks installation_date only. It
-- is a tax election, and an inferred year must not arrive in the depreciation
-- ledger looking like one someone recorded; calculateAnnualDepreciation falls
-- back to manufacture_date on its own and stamps the entry's notes when it
-- does.
--
-- Everything else — the row lock, the already-replaced check, the org_id
-- tenant boundary, the grants — is unchanged from
-- 20260814142502_replace_property_asset_rpc.sql. See that file's header for
-- why this is one transaction at all.
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
    installation_date, manufacture_date, placed_in_service_date, purchase_price,
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
    (p_new_asset->>'manufacture_date')::date,
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
