-- ============================================================================
-- submit_inspection()'s idempotent replay branch returns only
-- {ok: true, already_completed: true} — no signal about what was actually
-- recorded. The RPC's own comment documents this as a feature for the common
-- case (a retry of the exact same submit after a lost response), but the
-- outbox drain model means the CLIENT cannot distinguish "the server already
-- has my exact payload" from "the server has some earlier queued attempt with
-- different data": if the first submit reached the server and completed, but
-- the local outbox row still shows pending/failed (the response was lost in
-- flight, or the drain crashed after the server call succeeded but before
-- deleting the local mutation row), the device has no way to learn its cached
-- inspector_name may differ from what was actually persisted.
--
-- Fix: the replay branch now also returns the RECORDED inspector_name, so the
-- route (and eventually the client) can compare it against the locally queued
-- value and flag a mismatch instead of silently treating "already completed"
-- as "my exact data landed."
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_inspection(p_inspection_id uuid, p_inspector_name text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id          uuid;
  v_property_id     uuid;
  v_completed       timestamptz;
  v_form_snapshot   jsonb;
  v_written         integer;
  v_missing         integer;
  v_inspector_name  text;
BEGIN
  SELECT org_id, property_id, completed_at, form_snapshot, inspector_name
    INTO v_org_id, v_property_id, v_completed, v_form_snapshot, v_inspector_name
  FROM inspections WHERE id = p_inspection_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_completed IS NOT NULL THEN
    -- v_inspector_name here is what was actually persisted by the completion
    -- that already happened — lets a caller detect a mismatch against its
    -- own locally queued value rather than assuming a replay always means
    -- "my exact data landed."
    RETURN jsonb_build_object('ok', true, 'already_completed', true, 'inspector_name', v_inspector_name);
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

  -- Completeness backstop — see header. Runs AFTER the insert above so the
  -- answers just submitted are visible to the NOT EXISTS check within this
  -- same transaction, and BEFORE completed_at is ever set.
  SELECT count(*) INTO v_missing
  FROM jsonb_array_elements(coalesce(v_form_snapshot->'sections', '[]'::jsonb)) AS sec
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(sec->'items', '[]'::jsonb)) AS itm
  WHERE (itm->>'is_required')::boolean IS TRUE
    AND itm->>'parent_item_id'          IS NULL
    AND itm->>'repeat_source_item_id'   IS NULL
    AND coalesce((itm->>'repeat_per_asset')::boolean, false) = false
    AND coalesce((itm->>'per_unit')::boolean, false)         = false
    AND itm->>'asks_property_fact'        IS NULL
    AND itm->>'shown_when_property_fact'  IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM inspection_items ii
      WHERE ii.inspection_id = p_inspection_id
        AND ii.form_item_id  = (itm->>'id')::uuid
        AND (
          ii.result IS NOT NULL OR ii.value_number IS NOT NULL OR
          ii.value_text IS NOT NULL OR ii.value_date IS NOT NULL OR
          ii.photo_path IS NOT NULL OR ii.photo_unavailable_reason IS NOT NULL OR
          ii.na_reason IS NOT NULL
        )
    );

  IF v_missing > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'incomplete', 'missing_count', v_missing);
  END IF;

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
END $function$;
