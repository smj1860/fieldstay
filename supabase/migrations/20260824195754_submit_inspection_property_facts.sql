-- submit_inspection also records the property facts the walk captured.
--
-- The Safety form's `asks_property_fact` item renders only while
-- properties.has_security_system is NULL, so SOMETHING has to write it or the
-- question is asked forever and "ask once" is a lie the form tells.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- INSIDE THE RPC, NOT AFTER IT
--
-- The obvious alternative — the submit route updating `properties` once the RPC
-- returns — is two writes with no transaction around them, and the failure is
-- not symmetric. Answers committed with the fact unwritten means the capture
-- question comes back next year and the inspector answers it again: annoying,
-- self-correcting. Fact written with answers rolled back means the question is
-- gone forever and the record never contains the answer: silent, permanent, and
-- exactly the shape this codebase keeps paying for.
--
-- In here it is one transaction with the answers and the completion stamp.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- pass = TRUE, fail = FALSE, AND EVERYTHING ELSE LEAVES IT UNKNOWN
--
-- The item is a presence question rendered through the standard Pass/Fail/N-A
-- control, so Pass means "there is one" and Fail means "there is not". An N/A —
-- or a submit that never included the item because the gate had already
-- suppressed it — leaves the column NULL, which is honest: nobody answered, so
-- ask again next time.
--
-- ONLY WHEN STILL NULL. `WHERE has_security_system IS NULL` makes this
-- write-once. Without it a stale device replaying an old submit, or a resubmit
-- of a walk from before the PM corrected the value by hand, would silently
-- overwrite a deliberate correction with a year-old observation. The PM's edit
-- is the more recent statement of fact and has to win.

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
  v_org_id      uuid;
  v_property_id uuid;
  v_completed   timestamptz;
  v_written     integer;
BEGIN
  -- FOR UPDATE, so two drains racing the same submit serialize rather than
  -- both passing the completed_at check and both writing items.
  SELECT org_id, property_id, completed_at
    INTO v_org_id, v_property_id, v_completed
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

  -- ── Property facts captured by this walk ──────────────────────────────────
  -- Joined back through inspection_form_items rather than trusting the client
  -- to say which answers are facts: the item definition is what decides, and it
  -- is not something a submit payload should get a vote on.
  UPDATE properties p
     SET has_security_system = (a.result = 'pass'),
         updated_at          = now()
    FROM inspection_items a
    JOIN inspection_form_items fi ON fi.id = a.form_item_id
   WHERE p.id                   = v_property_id
     AND p.org_id               = v_org_id
     AND a.inspection_id        = p_inspection_id
     AND fi.asks_property_fact  = 'has_security_system'
     AND a.result IN ('pass', 'fail')
     AND p.has_security_system IS NULL;

  UPDATE inspections
     SET completed_at         = now(),
         inspector_name       = p_inspector_name,
         completed_by_user_id = auth.uid()
   WHERE id = p_inspection_id;

  RETURN jsonb_build_object('ok', true, 'items', v_written);
END $$;

REVOKE ALL ON FUNCTION submit_inspection(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_inspection(uuid, text, jsonb) TO authenticated;
