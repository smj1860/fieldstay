-- submit_inspection: carry the repeat-visit answer through to the record.
--
-- The two columns added by 20260824090000 are written at sign-off like every
-- other answer, which means they have to travel through this function's
-- `jsonb_to_recordset` cast list. THE CAST IS THE GATE, not the column type —
-- the same lesson `inventory_count_items.quantity_counted` taught when a
-- numeric column still rejected fractions because the RPC declared it
-- `integer`. A column added without a matching entry here is silently dropped
-- on every submit, and the write still reports success.
--
-- Verified against the live enum before applying: a jsonb string casts cleanly
-- into `inspection_repeat_answer`, an ABSENT key arrives as NULL rather than
-- erroring (which is what makes "not asked" the natural default), and an
-- invalid label raises 22P02 rather than being silently nulled.
--
-- Everything else about this function is unchanged — see 20260823022856 for
-- the transaction, ordering and idempotency reasoning, all of which still
-- applies verbatim.

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
    asset_id, repeat_index, answered_at,
    repeat_answer, repeat_of_work_order_id
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
    x.asset_id, x.repeat_index, x.answered_at,
    x.repeat_answer, x.repeat_of_work_order_id
  FROM jsonb_to_recordset(p_items) AS x(
    form_item_id uuid, prompt_snapshot text,
    result inspection_result, actions jsonb, needs_cleaning boolean,
    note text, photo_path text, photo_unavailable_reason text, na_reason text,
    value_number integer, value_text text, value_date date,
    asset_id uuid, repeat_index integer, answered_at timestamptz,
    repeat_answer inspection_repeat_answer, repeat_of_work_order_id uuid
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
    answered_at              = EXCLUDED.answered_at,
    repeat_answer            = EXCLUDED.repeat_answer,
    repeat_of_work_order_id  = EXCLUDED.repeat_of_work_order_id;

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
