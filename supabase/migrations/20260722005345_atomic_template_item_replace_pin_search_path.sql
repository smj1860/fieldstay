-- Reconciliation capture (Task 4, migration drift): this already exists
-- live under version 20260722005345 with no matching local file — captured
-- verbatim from pg_get_functiondef(). Pins search_path on the three
-- template-item-replace functions from 20260722000000_atomic_template_item_replace.sql.
CREATE OR REPLACE FUNCTION public.replace_room_template_items(p_room_template_id uuid, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.room_template_items
  WHERE room_template_id = p_room_template_id;

  INSERT INTO public.room_template_items (room_template_id, task, requires_photo, notes, sort_order)
  SELECT
    p_room_template_id,
    item->>'task',
    COALESCE((item->>'requires_photo')::boolean, false),
    NULLIF(item->>'notes', ''),
    COALESCE((item->>'sort_order')::int, 0)
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.replace_seed_room_template_items(p_template_id uuid, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM public.platform_seed_room_template_items
  WHERE platform_seed_room_template_id = p_template_id;

  INSERT INTO public.platform_seed_room_template_items (platform_seed_room_template_id, task, requires_photo, notes, sort_order)
  SELECT
    p_template_id,
    item->>'task',
    COALESCE((item->>'requires_photo')::boolean, false),
    NULLIF(item->>'notes', ''),
    COALESCE((item->>'sort_order')::int, 0)
  FROM jsonb_array_elements(p_items) AS item;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clone_inventory_from_property(p_org_id uuid, p_source_property_id uuid, p_target_property_id uuid)
 RETURNS TABLE(added integer, skipped integer, source_count integer)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_count integer;
  v_added        integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('clone_inventory_from_property'), hashtext(p_target_property_id::text));

  IF NOT EXISTS (
    SELECT 1 FROM public.properties
    WHERE id = p_target_property_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Target property not found in this organization';
  END IF;

  SELECT count(*) INTO v_source_count
  FROM public.inventory_items
  WHERE property_id = p_source_property_id
    AND org_id = p_org_id
    AND is_active = true;

  INSERT INTO public.inventory_items (
    property_id, org_id, catalog_item_id, name, category, unit,
    par_level, current_quantity, low_stock_threshold_pct, preferred_brand, is_active
  )
  SELECT
    p_target_property_id, p_org_id, s.catalog_item_id, s.name, s.category, s.unit,
    s.par_level, 0, COALESCE(s.low_stock_threshold_pct, 20), s.preferred_brand, true
  FROM public.inventory_items s
  WHERE s.property_id = p_source_property_id
    AND s.org_id = p_org_id
    AND s.is_active = true
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_items t
      WHERE t.property_id = p_target_property_id
        AND t.org_id = p_org_id
        AND t.is_active = true
        AND lower(t.name) = lower(s.name)
    );

  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN QUERY SELECT v_added, GREATEST(v_source_count - v_added, 0), v_source_count;
END;
$function$;
