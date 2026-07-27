-- Atomic delete+insert for a platform inventory template's item list, same
-- shape and same reasoning as replace_seed_room_template_items
-- (20260722000000_atomic_template_item_replace.sql): a plain app-level
-- delete-then-insert leaves the template with zero items if the insert
-- fails after the delete succeeds. SECURITY INVOKER (the default) is
-- deliberate — the function runs as the calling role so
-- platform_inventory_template_items_manage (gated on
-- is_platform_staff_admin()) keeps enforcing who's allowed to write.

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
    platform_inventory_template_id, catalog_item_id, par_level, preferred_brand, sort_order
  )
  SELECT
    p_template_id,
    (item->>'catalog_item_id')::uuid,
    COALESCE((item->>'par_level')::numeric, 1),
    NULLIF(item->>'preferred_brand', ''),
    COALESCE((item->>'sort_order')::int, 0)
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.replace_platform_inventory_template_items(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_platform_inventory_template_items(uuid, jsonb)
  TO authenticated;
