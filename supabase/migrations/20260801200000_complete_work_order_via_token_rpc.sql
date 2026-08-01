-- ============================================================================
-- Vendor work-order completion becomes ONE TRANSACTION.
--
-- FUTURE_REMEDIATION.md #16. The route
-- (app/api/work-orders/[token]/complete/route.ts) performed one logical action
-- across several non-transactional writes: allocate an invoice number, upsert
-- the invoice, atomically claim work_orders.status = 'completed', insert line
-- items, insert the status-change row. The 2026-07-31 pass reordered these so
-- the irreversible claim happens LAST and added rollbackUnclaimedInvoice() as
-- a compensating delete — which fixed the catastrophic case (a WO permanently
-- `completed` with no invoice, every vendor retry getting 409) but is a saga,
-- not a transaction. Three holes remained, all closed here:
--
--   1. rollbackUnclaimedInvoice() can itself fail — it logs, it cannot
--      guarantee. A crash between the invoice insert and the rollback leaves
--      an orphan invoice against a work order this request never completed.
--   2. Between the invoice upsert and the claim, an invoice exists for a work
--      order that is not yet 'completed'. Readers (PM invoice list, owner P&L)
--      can observe that state.
--   3. next_work_order_invoice_seq() is a separate round trip; a failure after
--      it burns a number and leaves a gap in the invoice sequence.
--
-- Inside one function body all of that collapses: either every row lands or
-- none does, so ORDER no longer carries correctness (the claim can go first
-- again, where it reads naturally as the mutex) and no compensating delete is
-- needed at all.
--
-- The route keeps everything that is NOT a database write — token validation,
-- payload validation, the audit log, and Inngest event dispatch — because
-- those must not be rolled back by a later DB failure and, in the case of
-- events, must not fire from inside a transaction that might abort.
--
-- Sequence note: nextval() is explicitly NON-transactional in Postgres, so a
-- rollback here still consumes the number. That is unchanged from before and
-- is correct — invoice numbers must never be reused, and a gap is harmless.
--
-- Grants: service_role ONLY. The caller is a public, unauthenticated vendor
-- token route that validates the token itself and then uses the service
-- client, so `authenticated` and `anon` have no business reaching this. RLS
-- does not apply inside a SECURITY DEFINER body, so the grant IS the boundary.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_work_order_via_token(
  p_work_order_id     uuid,
  p_line_items        jsonb,
  p_subtotal          numeric,
  p_notes             text,
  p_completed_by_name text,
  p_platform_fee_pct  numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_status      wo_status;
  v_wo               record;
  v_invoice_id       uuid;
  v_invoice_number   text;
  v_invoice_inserted boolean := false;
  v_has_line_items   boolean;
BEGIN
  v_has_line_items := p_line_items IS NOT NULL
                      AND jsonb_typeof(p_line_items) = 'array'
                      AND jsonb_array_length(p_line_items) > 0;

  -- Lock the row so the status check and the claim below cannot interleave
  -- with a concurrent completion. Inside the transaction this makes the whole
  -- sequence a single atomic decision rather than a check followed by a race.
  SELECT status INTO v_prev_status
    FROM public.work_orders
   WHERE id = p_work_order_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;

  IF v_prev_status NOT IN ('pending', 'assigned', 'in_progress') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_closed');
  END IF;

  -- Claim. completed_date matches the route's previous
  -- `new Date().toISOString().split('T')[0]` (a UTC date, not server-local).
  -- actual_cost is left untouched when the submission carried no priced line
  -- items, mirroring the previous `subtotal > 0 ? subtotal : undefined`.
  UPDATE public.work_orders
     SET status            = 'completed',
         completed_date    = (now() AT TIME ZONE 'UTC')::date,
         completion_notes  = p_notes,
         completed_by_name = p_completed_by_name,
         actual_cost       = CASE WHEN p_subtotal > 0 THEN p_subtotal ELSE actual_cost END
   WHERE id = p_work_order_id
  RETURNING id, org_id, vendor_id, property_id, wo_number, source_turnover_id
       INTO v_wo;

  -- Invoice, only when the vendor priced the job. UNIQUE (work_order_id) is
  -- the dedupe key; ON CONFLICT DO NOTHING plus the follow-up SELECT means a
  -- replay reuses the existing invoice rather than ever creating a second.
  IF v_has_line_items AND v_wo.vendor_id IS NOT NULL THEN
    v_invoice_number := 'INV-'
      || to_char(now() AT TIME ZONE 'UTC', 'YYYY')
      || '-'
      || lpad(nextval('public.work_order_invoice_seq')::text, 5, '0');

    INSERT INTO public.work_order_invoices (
      org_id, work_order_id, vendor_id, property_id,
      invoice_number, status, subtotal, total, platform_fee_amount
    ) VALUES (
      v_wo.org_id, v_wo.id, v_wo.vendor_id, v_wo.property_id,
      v_invoice_number, 'pending_payment', p_subtotal, p_subtotal,
      round(p_subtotal * COALESCE(p_platform_fee_pct, 0), 2)
    )
    ON CONFLICT (work_order_id) DO NOTHING
    RETURNING id INTO v_invoice_id;

    IF v_invoice_id IS NULL THEN
      SELECT id INTO v_invoice_id
        FROM public.work_order_invoices
       WHERE work_order_id = v_wo.id;
      v_invoice_number := NULL;   -- this request did not mint the number
    ELSE
      v_invoice_inserted := true;
    END IF;

    -- line_total is DELIBERATELY absent: it is GENERATED ALWAYS AS
    -- (quantity * unit_cost) STORED on both projects, so naming it in an
    -- INSERT raises 428C9 "cannot insert a non-DEFAULT value into column".
    -- That is exactly the live bug this migration surfaced — the previous
    -- insertVendorLineItems() DID name it, and only console.error'd on
    -- failure, so every vendor completion silently persisted ZERO line items.
    -- The column type is numeric(10,2), so the generated value is already
    -- rounded to cents, matching the Math.round(x * 100) / 100 it replaces.
    --
    -- NOTE: supabase/schema_reference.sql describes this column as a plain
    -- DEFAULT rather than GENERATED, which is what made the original insert
    -- look correct. The live database is authoritative (CLAUDE.md).
    INSERT INTO public.work_order_line_items (
      work_order_id, org_id, line_type, description,
      quantity, unit_cost, sort_order, vendor_submitted
    )
    SELECT
      v_wo.id,
      v_wo.org_id,
      (item->>'line_type')::line_item_type,
      btrim(item->>'description'),
      (item->>'quantity')::numeric,
      (item->>'unit_cost')::numeric,
      (ord - 1)::smallint,
      true
    FROM jsonb_array_elements(p_line_items) WITH ORDINALITY AS t(item, ord);
  END IF;

  INSERT INTO public.work_order_updates (
    work_order_id, org_id, updated_via_vendor_portal,
    status_from, status_to, notes
  ) VALUES (
    v_wo.id, v_wo.org_id, true, v_prev_status, 'completed', p_notes
  );

  RETURN jsonb_build_object(
    'claimed',          true,
    'previous_status',  v_prev_status,
    'work_order', jsonb_build_object(
      'id',                 v_wo.id,
      'org_id',             v_wo.org_id,
      'vendor_id',          v_wo.vendor_id,
      'property_id',        v_wo.property_id,
      'wo_number',          v_wo.wo_number,
      'source_turnover_id', v_wo.source_turnover_id
    ),
    'invoice_id',       v_invoice_id,
    'invoice_number',   v_invoice_number,
    'invoice_inserted', v_invoice_inserted
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_work_order_via_token(uuid, jsonb, numeric, text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.complete_work_order_via_token(uuid, jsonb, numeric, text, text, numeric)
  TO service_role;

NOTIFY pgrst, 'reload schema';
