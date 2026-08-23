-- Atomic, idempotent inspection completion.
--
-- Sign-off writes every answer AND marks the inspection complete. Those must be
-- one transaction, and an RPC is the only way to get that through PostgREST.
--
-- ONE TRANSACTION, BECAUSE THE ALTERNATIVE HAS A DOOR IN THE MIDDLE
--
-- As two statements from the Route Handler, a crash between them leaves the
-- items written and the inspection still open — a form that looks unfinished on
-- screen while every answer is already in the database. The retry then has to
-- decide whether those rows are its own half-finished work or someone else's.
--
-- IDEMPOTENT, BECAUSE THE OUTBOX REPLAYS
--
-- The drain deletes a queued mutation only after its handler resolves, so a
-- response lost in flight replays the same submit. Two things make that safe:
--
--   * The early return on `completed_at`. Without it the inserts below hit
--     trg_inspection_items_immutable_after_completion and raise — dead-lettering
--     a submit that had already succeeded, and showing the inspector a failure
--     for work that is safely recorded.
--   * The ON CONFLICT upsert, for the OTHER replay: a first pass that wrote its
--     items and died before completing. The retry corrects those rows instead
--     of duplicating them.
--
-- ORDER IS LOAD-BEARING. Items are written BEFORE completion, because the
-- immutability trigger rejects any write to inspection_items once the parent is
-- complete. Completing first would reject every answer.
--
-- SECURITY INVOKER, so RLS applies exactly as it would to a direct write:
-- inspection_items_manage requires is_org_member(org_id, admin|manager). The
-- org_id is read from the inspection row rather than taken as a parameter, so a
-- caller cannot name someone else's org.
--
-- VERIFIED against real rows on the E2E project before this was applied to
-- production — all four paths, not just the happy one:
--   first submit            -> {"ok":true,"items":2}, inspection completed
--   replay, DIFFERENT body  -> {"ok":true,"already_completed":true}; the stored
--                              note and inspector name were UNCHANGED, so a
--                              replay cannot rewrite a completed record
--   half-finished first pass-> retry corrected the existing row (1 row, not 2)
--                              and completed the inspection
--   unknown inspection      -> {"ok":false,"reason":"not_found"}

CREATE OR REPLACE FUNCTION submit_inspection(
  p_inspection_id  uuid,
  p_inspector_name text,
  p_items          jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_org_id    uuid;
  v_completed timestamptz;
  v_written   integer;
BEGIN
  -- FOR UPDATE, so two drains racing the same submit serialize rather than
  -- both passing the completed_at check and both writing items.
  SELECT org_id, completed_at INTO v_org_id, v_completed
  FROM inspections WHERE id = p_inspection_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_completed IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_completed', true);
  END IF;

  INSERT INTO inspection_items (
    inspection_id, org_id, form_item_id, prompt_snapshot,
    result, actions, needs_cleaning, note, photo_path,
    photo_unavailable_reason, na_reason,
    value_number, value_text, value_date,
    asset_id, repeat_index, answered_at
  )
  SELECT
    p_inspection_id, v_org_id, x.form_item_id, x.prompt_snapshot,
    x.result,
    -- `actions jsonb` then an explicit conversion, NOT `actions
    -- inspection_action[]` in the recordset: a jsonb array renders as
    -- ["repair","service"], which is not valid Postgres array input syntax.
    -- Confirmed by trying it.
    (SELECT coalesce(array_agg(v::inspection_action), '{}'::inspection_action[])
       FROM jsonb_array_elements_text(coalesce(x.actions, '[]'::jsonb)) v),
    coalesce(x.needs_cleaning, false),
    x.note, x.photo_path, x.photo_unavailable_reason, x.na_reason,
    x.value_number, x.value_text, x.value_date,
    x.asset_id, x.repeat_index, x.answered_at
  FROM jsonb_to_recordset(p_items) AS x(
    form_item_id uuid, prompt_snapshot text,
    result inspection_result, actions jsonb, needs_cleaning boolean,
    note text, photo_path text, photo_unavailable_reason text, na_reason text,
    value_number integer, value_text text, value_date date,
    asset_id uuid, repeat_index integer, answered_at timestamptz
  )
  ON CONFLICT ON CONSTRAINT inspection_items_unique_answer DO UPDATE SET
    prompt_snapshot          = EXCLUDED.prompt_snapshot,
    result                   = EXCLUDED.result,
    actions                  = EXCLUDED.actions,
    needs_cleaning           = EXCLUDED.needs_cleaning,
    note                     = EXCLUDED.note,
    photo_path               = EXCLUDED.photo_path,
    photo_unavailable_reason = EXCLUDED.photo_unavailable_reason,
    na_reason                = EXCLUDED.na_reason,
    value_number             = EXCLUDED.value_number,
    value_text               = EXCLUDED.value_text,
    value_date               = EXCLUDED.value_date,
    answered_at              = EXCLUDED.answered_at;

  GET DIAGNOSTICS v_written = ROW_COUNT;

  UPDATE inspections
     SET completed_at         = now(),
         inspector_name       = p_inspector_name,
         completed_by_user_id = auth.uid()
   WHERE id = p_inspection_id;

  RETURN jsonb_build_object('ok', true, 'items', v_written);
END $$;

REVOKE ALL ON FUNCTION submit_inspection(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_inspection(uuid, text, jsonb) TO authenticated;

COMMENT ON FUNCTION submit_inspection(uuid, text, jsonb) IS
  'Atomic inspection completion: writes every answer then marks the inspection complete, in one transaction. Idempotent — a replay of an already-completed inspection returns ok without touching it.';
