-- ============================================================================
-- broadcastMaintenanceTemplate() had a TOCTOU race: it read existingSchedules
-- once at the top of the action, computed rowsToInsert from that snapshot,
-- then inserted — with no DB-level guard behind the dedup. The function's own
-- comment explains why a real unique constraint on (property_id, name) can
-- never exist here: duplicateMaintenanceScheduleItem deliberately copies a
-- row's name onto the same property on purpose. So the usual "add a unique
-- index + upsert ignoreDuplicates" fix is not available for this table.
--
-- Two concurrent broadcasts of the same template to the same properties — a
-- double-clicked "Apply Template" before the button disables, two admins
-- applying the same template around the same time, or a client retry after a
-- timeout whose first request is still in flight — both read the same
-- existingNames set (neither has committed yet), both compute the identical
-- rowsToInsert, and both succeed: duplicate maintenance_schedules rows, each
-- independently generating its own recurring work orders forever
-- (auto_create_wo: true), silently doubling every future WO for that item on
-- that property. Both broadcasts report success.
--
-- Fix: a Postgres advisory xact lock, scoped to (org_id, template_id), taken
-- as the first statement of one RPC call that ALSO does the existence
-- re-check and the insert — so the whole check-then-act sequence runs inside
-- a single lock-held transaction instead of two racing round trips. The lock
-- releases automatically at the end of the RPC's transaction. This is the
-- audit's own documented fallback for a table where a real unique constraint
-- is impossible for product reasons.
--
-- The candidate rows are still computed in TypeScript (property × item,
-- minus a first-pass existence filter, unchanged) — this RPC re-verifies
-- existence UNDER THE LOCK immediately before inserting, so it is the actual
-- source of truth regardless of how stale the caller's pre-lock read was.
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
  -- Serializes concurrent broadcasts of the SAME template for the SAME org.
  -- A different template, or a different org, hashes to a different lock and
  -- proceeds unblocked — the race is specifically "same template, same
  -- property set", which shares a (property_id, name) key space.
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
  -- read, which is exactly the snapshot two concurrent callers would race on.
  to_insert AS (
    SELECT c.* FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1 FROM maintenance_schedules ms
      WHERE ms.org_id = p_org_id
        AND ms.property_id = c.property_id
        AND ms.name = c.name
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

-- SECURITY INVOKER (the default — no marker needed): runs under the caller's
-- own RLS-enforced session, matching how the pre-existing .insert() call in
-- broadcastMaintenanceTemplate() already worked. requireOrgRole(['admin',
-- 'manager']) gates the caller before this RPC is ever invoked, and RLS's own
-- is_org_member() write policy backs it up independently.
GRANT EXECUTE ON FUNCTION public.broadcast_maintenance_schedules(uuid, uuid, jsonb) TO authenticated;
