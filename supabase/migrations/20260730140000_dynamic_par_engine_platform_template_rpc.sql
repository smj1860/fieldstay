-- Dynamic PAR engine, pass 3 — carry par_mode/smart_group/base_qty through
-- replace_platform_inventory_template_items, the RPC the admin platform
-- templates screen (/admin/inventory-templates) uses to atomically replace a
-- template's item list. Discovered mid-pass: the JSONB item parsing only
-- extracted catalog_item_id/par_level/preferred_brand/sort_order, so the
-- three columns pass 1 added to platform_inventory_template_items would have
-- been silently dropped on every save from this screen. Not anticipated by
-- the original pass-3 scope ("no migration expected"), but required for the
-- admin catalog -> platform template -> broadcast chain to actually carry
-- smart config end to end.
--
-- Full re-create preserving the body from
-- 20260727130000_platform_inventory_template_rpc.sql exactly, with ONLY the
-- INSERT column list / SELECT list extended.

CREATE OR REPLACE FUNCTION public.replace_platform_inventory_template_items(
  p_template_id uuid,
  p_items       jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.platform_inventory_template_items
  WHERE platform_inventory_template_id = p_template_id;

  INSERT INTO public.platform_inventory_template_items (
    platform_inventory_template_id, catalog_item_id, par_level, preferred_brand, sort_order,
    par_mode, smart_group, base_qty
  )
  SELECT
    p_template_id,
    (item->>'catalog_item_id')::uuid,
    COALESCE((item->>'par_level')::numeric, 1),
    NULLIF(item->>'preferred_brand', ''),
    COALESCE((item->>'sort_order')::int, 0),
    COALESCE((item->>'par_mode')::par_mode, 'static'),
    NULLIF(item->>'smart_group', '')::par_smart_group,
    COALESCE((item->>'base_qty')::numeric, 1)
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.replace_platform_inventory_template_items(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_platform_inventory_template_items(uuid, jsonb)
  TO authenticated;
