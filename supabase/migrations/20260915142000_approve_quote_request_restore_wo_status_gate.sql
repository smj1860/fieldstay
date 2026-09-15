-- ============================================================================
-- approve_quote_request() lost its cancelled/completed work-order guard.
--
-- 20260801280000_authz_gate_security_definer_rpcs.sql originally added:
--   IF v_wo_status IN ('completed', 'cancelled') THEN
--     RETURN jsonb_build_object('ok', false, 'reason', 'work_order_not_assignable');
--   END IF;
-- right after locking the work order — closing exactly this hole:
-- deleteWorkOrder sets status = 'cancelled' without settling that WO's
-- quote_requests, and the public vendor quote-submission route doesn't check
-- WO status either. So a vendor quote can be submitted (or already be sitting
-- submitted) against a WO the PM has since cancelled or completed, and
-- approving it would reassign vendor_id, flip status back to 'assigned',
-- re-enable the public vendor portal, and mint a fresh completion_token —
-- resurrecting a dead work order with a live, unauthenticated completion
-- credential.
--
-- 20260802120000_approve_quote_request_lock_order.sql's CREATE OR REPLACE
-- (written to fix a lock-ordering deadlock) was evidently built from an
-- earlier, unpatched copy of the function body: it goes straight from
-- locking work_orders to locking quote_requests with no status check in
-- between. Every CREATE OR REPLACE since (20260805191000, 20260805191500)
-- carried the gap forward unchanged — confirmed against the function's
-- actual live definition via pg_get_functiondef immediately before writing
-- this migration.
--
-- Restoring the check here, in the same position it originally occupied:
-- immediately after the work_orders row is locked, before anything touches
-- quote_requests or writes back to work_orders.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.approve_quote_request(
  p_quote_request_id   uuid,
  p_org_id             uuid,
  p_completion_token   text,
  p_token_expires_at   timestamp with time zone
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  SELECT status INTO v_wo_status
    FROM public.work_orders
   WHERE id     = v_work_order_id
     AND org_id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'work_order_not_found');
  END IF;

  -- RESTORED: dropped by 20260802120000_approve_quote_request_lock_order.sql,
  -- never restored since. See this migration's header for the exploit chain.
  IF v_wo_status IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'work_order_not_assignable');
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
$function$;

NOTIFY pgrst, 'reload schema';
