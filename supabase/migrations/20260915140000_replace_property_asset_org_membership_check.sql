-- ============================================================================
-- replace_property_asset() had no check that the CALLER actually belongs to
-- p_org_id — only that the old asset row itself belongs to p_org_id. Because
-- the function is SECURITY DEFINER (RLS does not apply inside its body) and
-- GRANTed to `authenticated`, any signed-in user of ANY org could call the
-- PostgREST RPC endpoint directly with someone else's org_id and replace
-- that org's asset — a cross-tenant IDOR. The header comment on the original
-- migration (20260814142502) asserted "the caller passes membership.org_id
-- from requireOrgRole(), never a client-supplied value" as if that were a
-- guarantee, but that only describes the ONE call site
-- (app/(dashboard)/properties/actions.ts's replacePropertyAssetAction) — it
-- says nothing about a request built and sent straight to
-- /rest/v1/rpc/replace_property_asset with a Supabase anon/authenticated JWT
-- for a different org, which PostgREST will happily forward.
--
-- Fix: re-verify the caller's membership inside the function body, matching
-- the role list actually enforced by the app-level call site
-- (PROPERTY_WRITE_ROLES = ['admin', 'manager'] in properties/actions.ts).
-- is_org_member() also passes 'owner' automatically (see CLAUDE.md), so an
-- org owner is not locked out even though 'owner' is not itself in the list.
--
-- Rebased on the function's actual live definition (confirmed via
-- pg_get_functiondef against production), which already carries
-- manufacture_date from 20260816193212 — that column must stay in the INSERT
-- here too, or this migration would silently regress it.
-- ============================================================================

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
  IF NOT public.is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

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

NOTIFY pgrst, 'reload schema';
