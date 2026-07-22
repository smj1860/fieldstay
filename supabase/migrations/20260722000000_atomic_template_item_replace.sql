-- Fix: saveRoomTemplateItems / saveSeedTemplateItems did an app-level
-- delete-then-insert. If the insert failed after the delete succeeded
-- (network blip, validation error, retry), the template was left with
-- zero items and no way back. Wrap both in a single plpgsql function so
-- Postgres rolls back the delete automatically if the insert raises.
--
-- SECURITY INVOKER (the default) is deliberate here, not SECURITY
-- DEFINER — both functions run as the calling role so the existing RLS
-- policies (room_template_items_insert/_delete gated on
-- is_org_member(room_templates.org_id, admin|manager|owner);
-- platform_seed_room_template_items_manage gated on
-- is_platform_staff_admin()) keep enforcing who's allowed to write,
-- exactly as they did for the two separate statements before.

CREATE OR REPLACE FUNCTION public.replace_room_template_items(
  p_room_template_id uuid,
  p_items             jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
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

REVOKE EXECUTE ON FUNCTION public.replace_room_template_items(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_room_template_items(uuid, jsonb)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.replace_seed_room_template_items(
  p_template_id uuid,
  p_items        jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
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

REVOKE EXECUTE ON FUNCTION public.replace_seed_room_template_items(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_seed_room_template_items(uuid, jsonb)
  TO authenticated;

-- Fix: cloneInventoryFromProperty (templates/inventory/actions.ts) had two
-- bugs — (1) it never verified p_target_property_id belonged to the
-- caller's org before inserting into it (RLS doesn't backstop this either
-- — inventory_items_insert only checks org_id matches the membership, not
-- that property_id itself belongs to that org_id), and (2) its
-- read-existing-names-then-insert sequence was a plain TOCTOU race: two
-- concurrent clones at the same target property could both pass the
-- "does this name already exist" check and double-insert.
--
-- A plain UNIQUE(property_id, org_id, lower(name)) constraint is the
-- textbook fix for (2), but live data already has duplicate active
-- (property_id, lower(name)) rows today (verified via execute_sql before
-- writing this migration) — almost certainly from this exact bug over
-- time. Adding that constraint now would fail to apply until those rows
-- are cleaned up, which is a separate data migration, not a schema fix.
-- Using a transaction-scoped advisory lock instead: it can't retroactively
-- fix existing duplicates, but it closes the race for every clone from
-- this point forward without depending on a constraint that can't ship
-- against current data.
CREATE OR REPLACE FUNCTION public.clone_inventory_from_property(
  p_org_id             uuid,
  p_source_property_id uuid,
  p_target_property_id uuid
) RETURNS TABLE(added integer, skipped integer, source_count integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_source_count integer;
  v_added        integer;
BEGIN
  -- Namespaced against the target property id so concurrent clones into
  -- *different* properties never contend, only two clones racing into the
  -- same target.
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

REVOKE EXECUTE ON FUNCTION public.clone_inventory_from_property(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clone_inventory_from_property(uuid, uuid, uuid)
  TO authenticated;
