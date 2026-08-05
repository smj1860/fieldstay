-- ============================================================================
-- Approving a quote now carries its line items onto the work order.
--
-- This is the handoff the RFQ flow was missing. Before: approval assigned the
-- vendor and copied one number into work_orders.estimated_cost. The scope the
-- vendor priced — which lines, at what quantity, at what unit cost — existed
-- only inside the quote, and the vendor arrived at the completion portal to a
-- blank line-item form. They re-typed the same breakdown from memory, and
-- nothing in the system could compare what was agreed against what was billed.
--
-- The copy lands with vendor_submitted = false, which is the load-bearing
-- distinction:
--
--   vendor_submitted = false → the AGREED SCOPE, from the approved quote
--   vendor_submitted = true  → the INVOICE, from complete_work_order_via_token
--
-- app/(dashboard)/invoices/[invoiceId]/page.tsx already filters on
-- `vendor_submitted = true`, so the quoted lines cannot leak onto the invoice
-- and double it — the invoice keeps showing exactly what the vendor billed.
-- The work-order detail page shows both, which is the point: the variance
-- between them is the only thing that tells a PM the job came in over scope.
--
-- sort_order is OFFSET past whatever the work order already has, rather than
-- starting at 0. A PM who added their own lines before requesting quotes would
-- otherwise get two items both claiming sort_order 0, and the detail page
-- orders by it — the resulting sequence is stable only by accident of
-- insertion order.
--
-- line_total is DELIBERATELY absent from the INSERT column list. It is
-- GENERATED ALWAYS on BOTH tables, and naming it raises 428C9, which rejects
-- the whole statement. See CLAUDE.md — this class shipped twice.
--
-- Everything else is unchanged from 20260802120000, including the parent-first
-- lock order that fixed the two-PM approval deadlock, and the deliberate
-- decision to leave the vendor-compliance check in the calling Server Action
-- ahead of this function so a hard-blocked vendor is refused before any claim.
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

  -- ── Unlocked pre-read: find the parent, and fast-path a decided quote ────
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

  -- ── 1. PARENT FIRST. This is the deadlock fix from 20260802120000. ──────
  SELECT status INTO v_wo_status
    FROM public.work_orders
   WHERE id     = v_work_order_id
     AND org_id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'work_order_not_found');
  END IF;

  -- ── 2. Then the child, re-validated under its own lock ──────────────────
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

  -- ── Carry the quoted scope onto the work order ──────────────────────────
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
         completion_token           = p_completion_token,
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
