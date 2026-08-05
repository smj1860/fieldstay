-- ============================================================================
-- approve_quote_request could never complete. Not "in an edge case" — never,
-- on any input, since the function was created.
--
--   p_completion_token  text          ← the parameter
--   work_orders.completion_token uuid ← the column
--
--   UPDATE public.work_orders SET completion_token = p_completion_token
--
-- plpgsql does not implicitly cast text to uuid in an UPDATE target, so this
-- raises 42804 "column is of type uuid but expression is of type text" the
-- moment it executes. It is not value-dependent: a perfectly valid UUID string
-- fails identically to garbage. Every approval would have died there, and
-- because the statement sits AFTER the quote has been claimed and its siblings
-- declined, the abort rolls the whole transaction back and the Server Action
-- returns the generic 'Operation failed. Please try again.' — with nothing in
-- the message pointing at a type mismatch.
--
-- It survived two prior revisions of this function (20260801270000 added it,
-- 20260802120000 rewrote the lock order around it and carried it forward
-- verbatim) for one reason: nothing has ever called it. quote_requests holds
-- zero rows in production, and approveQuoteRequest is one of three quote
-- actions with no UI caller at all — all three are in
-- unit/guardrails/unreferenced-server-actions.test.ts's BASELINE. It was found
-- by exercising the function directly against the E2E project before wiring
-- the PM entry point, which is exactly the check a dead code path never gets.
--
-- This is the same shape as the /wo/[token] dispatch bug fixed earlier in this
-- audit — a text token written into a uuid column — and the second time that
-- pairing has produced a 100%-failure path in this codebase.
--
-- FIXED by casting at the assignment. The signature stays `text` deliberately:
-- changing it would require DROP/CREATE (a plain CREATE OR REPLACE cannot
-- change a parameter type), re-issuing the REVOKE/GRANT, and editing the
-- TypeScript call site — three things to get right for no behavioural gain.
-- The caller mints the value with crypto.randomUUID(), so the cast is total
-- for every real input; a non-UUID string would raise 22P02 and abort, which
-- is the correct outcome for a caller that has stopped honouring the contract.
--
-- Everything else is unchanged from 20260805191000.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.approve_quote_request(
  p_quote_request_id  uuid,
  p_org_id            uuid,
  p_completion_token  text,
  p_token_expires_at  timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_work_order_id uuid;
  v_vendor_id     uuid;
  v_quoted        numeric;
  v_qr_status     quote_request_status;
  v_wo_status     wo_status;
  v_declined      integer := 0;
  v_sort_offset   smallint;
  v_copied        integer := 0;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  SELECT work_order_id, status
    INTO v_work_order_id, v_qr_status
    FROM public.quote_requests
   WHERE id     = p_quote_request_id
     AND org_id = p_org_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quote_not_found');
  END IF;

  IF v_qr_status <> 'submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_submitted');
  END IF;

  -- PARENT FIRST — the deadlock fix from 20260802120000.
  SELECT status INTO v_wo_status
    FROM public.work_orders
   WHERE id     = v_work_order_id
     AND org_id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'work_order_not_found');
  END IF;

  SELECT vendor_id, quoted_amount, status
    INTO v_vendor_id, v_quoted, v_qr_status
    FROM public.quote_requests
   WHERE id     = p_quote_request_id
     AND org_id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quote_not_found');
  END IF;

  IF v_qr_status <> 'submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_submitted');
  END IF;

  UPDATE public.quote_requests
     SET status = 'approved'
   WHERE id = p_quote_request_id;

  UPDATE public.quote_requests
     SET status = 'declined'
   WHERE work_order_id = v_work_order_id
     AND org_id        = p_org_id
     AND id           <> p_quote_request_id
     AND status IN ('pending', 'submitted');
  GET DIAGNOSTICS v_declined = ROW_COUNT;

  SELECT COALESCE(MAX(sort_order) + 1, 0)::smallint
    INTO v_sort_offset
    FROM public.work_order_line_items
   WHERE work_order_id = v_work_order_id;

  -- line_total omitted: GENERATED ALWAYS on both tables (see 20260805191000).
  INSERT INTO public.work_order_line_items (
    work_order_id, org_id, line_type, description,
    quantity, unit, unit_cost, sort_order, vendor_submitted
  )
  SELECT
    v_work_order_id,
    p_org_id,
    qrli.line_type,
    qrli.description,
    qrli.quantity,
    qrli.unit,
    qrli.unit_cost,
    (v_sort_offset + qrli.sort_order)::smallint,
    false
  FROM public.quote_request_line_items qrli
  WHERE qrli.quote_request_id = p_quote_request_id
    AND qrli.org_id           = p_org_id
  ORDER BY qrli.sort_order;
  GET DIAGNOSTICS v_copied = ROW_COUNT;

  UPDATE public.work_orders
     SET vendor_id                  = v_vendor_id,
         status                     = 'assigned',
         estimated_cost             = COALESCE(v_quoted, estimated_cost),
         portal_enabled             = true,
         -- THE FIX: completion_token is uuid, the parameter is text.
         completion_token           = p_completion_token::uuid,
         completion_token_expires_at = p_token_expires_at
   WHERE id     = v_work_order_id
     AND org_id = p_org_id;

  INSERT INTO public.work_order_updates (
    work_order_id, org_id, updated_via_vendor_portal,
    status_from, status_to, notes
  ) VALUES (
    v_work_order_id, p_org_id, false,
    v_wo_status, 'assigned',
    'Quote approved — $' || COALESCE(to_char(v_quoted, 'FM999999990.00'), '?')
      || CASE WHEN v_copied > 0
              THEN ' (' || v_copied || ' line item'
                   || CASE WHEN v_copied = 1 THEN '' ELSE 's' END || ')'
              ELSE '' END
      || '. Vendor assigned and notified.'
  );

  RETURN jsonb_build_object(
    'ok',            true,
    'work_order_id', v_work_order_id,
    'vendor_id',     v_vendor_id,
    'quoted_amount', v_quoted,
    'declined',      v_declined,
    'line_items_copied', v_copied
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.approve_quote_request(uuid, uuid, text, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.approve_quote_request(uuid, uuid, text, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
