-- ============================================================================
-- broadcast_maintenance_schedules()'s existence re-check (20260915152000)
-- deduped purely on (property_id, name). That is the wrong key: two
-- UNRELATED templates that happen to share an item name (a very plausible
-- collision — "HVAC Filter Replacement" is exactly the kind of name the
-- FieldStay Standard catalog ships) silently cannibalize each other —
-- Template B's item is skipped as "already exists" even though it is
-- logically a different schedule the PM explicitly asked to create. And
-- renaming a saved template's item produces a SECOND schedule on
-- re-broadcast rather than being recognized as the same maintenance item,
-- because the new name no longer matches the old row.
--
-- Fix: dedupe on the TEMPLATE ITEM's row id (source_template_item_id) when
-- the candidate row carries one — which every row from
-- broadcastMaintenanceTemplate() does. A template item's id survives a
-- rename, so a re-broadcast after renaming correctly recognizes the existing
-- schedule instead of duplicating it, and two different templates' items
-- never collide on name alone. A schedule with no source_template_item_id
-- (hand-created, or copied by duplicateMaintenanceScheduleItem) still falls
-- back to the name key — the only key anything can compare it against.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcast_maintenance_schedules(
  p_org_id      uuid,
  p_template_id uuid,
  p_rows        jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_inserted integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_org_id::text || ':' || p_template_id::text));

  WITH candidates AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      property_id               uuid,
      org_id                    uuid,
      name                      text,
      description               text,
      schedule_type             schedule_type,
      frequency                 schedule_frequency,
      vendor_specialty_hint     vendor_specialty,
      estimated_cost            numeric,
      auto_create_wo            boolean,
      next_due_date             date,
      is_active                 boolean,
      active_from_month         int,
      active_to_month           int,
      asset_category            text,
      is_from_standard_template boolean,
      source_template_item_id   uuid
    )
  ),
  -- Re-checked HERE, under the lock — not trusting the caller's pre-lock
  -- read, same as before. The MATCH is now the template item's row id, not
  -- the name, so a rename or a cross-template name collision cannot fool it.
  to_insert AS (
    SELECT c.* FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1 FROM maintenance_schedules ms
      WHERE ms.org_id = p_org_id
        AND ms.property_id = c.property_id
        AND (
          ms.source_template_item_id = c.source_template_item_id
          OR (ms.source_template_item_id IS NULL AND ms.name = c.name)
        )
    )
  ),
  ins AS (
    INSERT INTO maintenance_schedules (
      property_id, org_id, name, description, schedule_type, frequency,
      vendor_specialty_hint, estimated_cost, auto_create_wo, next_due_date,
      is_active, active_from_month, active_to_month, asset_category,
      is_from_standard_template, source_template_item_id
    )
    SELECT
      property_id, org_id, name, description, schedule_type, frequency,
      vendor_specialty_hint, estimated_cost, auto_create_wo, next_due_date,
      is_active, active_from_month, active_to_month, asset_category,
      is_from_standard_template, source_template_item_id
    FROM to_insert
    RETURNING 1
  )
  SELECT count(*) FROM ins INTO v_inserted;

  RETURN jsonb_build_object('inserted', v_inserted);
END;
$$;

COMMENT ON FUNCTION public.broadcast_maintenance_schedules(uuid, uuid, jsonb) IS
  'Broadcasts a maintenance template''s items to properties under an advisory '
  'lock scoped to (org_id, template_id). Dedupes each candidate row against '
  'an existing schedule on the SAME property that shares its '
  'source_template_item_id (survives a template-item rename, and never '
  'collides across two different templates that happen to share an item '
  'name) — falling back to a name match only for schedules with no '
  'source_template_item_id at all (hand-created or copied).';

GRANT EXECUTE ON FUNCTION public.broadcast_maintenance_schedules(uuid, uuid, jsonb) TO authenticated;
