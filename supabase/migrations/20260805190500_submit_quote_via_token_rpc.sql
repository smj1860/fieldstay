-- ============================================================================
-- Itemized quote submission, as one transaction.
--
-- The route previously did the whole submission as three sequential writes
-- against an unauthenticated token: UPDATE the quote, INSERT a work_order_
-- updates row, send an Inngest event. With line items added there is a fourth,
-- and it is the one that must not be able to half-apply: a quote row that says
-- `submitted` with `quoted_amount = $4,200` and zero line items behind it is a
-- number the PM cannot audit and the approve path cannot copy. It would also
-- be permanent — the claim is `WHERE status = 'pending'`, so the vendor's
-- retry is refused as "already submitted".
--
-- THE TOTAL IS DERIVED, NEVER ACCEPTED. quoted_amount is SUM(line_total) over
-- the rows this function just inserted, and line_total is itself GENERATED
-- ALWAYS AS (quantity * unit_cost). There is no path by which a client-stated
-- total reaches the database. This is the same control the completion route
-- had to learn the hard way — see the comment block in
-- app/api/work-orders/[token]/complete/route.ts about `subtotal` arriving from
-- the request body and being written to work_orders.actual_cost and the Stripe
-- platform fee. The quote flow is the same unauthenticated shape and gets the
-- same treatment from the start.
--
-- LOCK ORDER: PARENT (work_orders) FIRST, exactly as approve_quote_request was
-- corrected to do in 20260802120000. This is not symmetry for its own sake —
-- the two functions genuinely contend:
--
--   approve  holds work_orders FOR UPDATE, then UPDATEs sibling quote rows
--   submit   holds its quote row, then INSERTs work_order_updates, whose FK
--            check takes FOR KEY SHARE on that same work_orders row — which
--            CONFLICTS with the FOR UPDATE approve is holding
--
-- A vendor submitting while the PM approves a competitor on the same work
-- order is an ordinary race, not a contrived one. Locking the parent first in
-- both functions makes the two fully serialise: a submission that arrives
-- mid-approval either lands entirely before it, or finds its own quote already
-- 'declined' and is refused with nothing written.
--
-- p_notes is normalised with NULLIF(btrim(...), '') rather than stored as
-- given: the route's generated RPC types declare the parameter non-nullable,
-- so an absent note arrives as '' rather than NULL, and a column that holds
-- both for the same meaning makes every reader carry two empty checks.
--
-- SECURITY DEFINER with no auth.role() gate, deliberately and unlike
-- approve_quote_request: the caller here is an unauthenticated vendor holding
-- a quote token. The token IS the authorization, so EXECUTE is granted to
-- service_role only and the route reaches it through createServiceClient.
-- Every predicate below is keyed on the token.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_quote_via_token(
  p_quote_token  text,
  p_line_items   jsonb,
  p_notes        text,
  p_max_total    numeric DEFAULT 1000000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_qr_id         uuid;
  v_org_id        uuid;
  v_work_order_id uuid;
  v_status        quote_request_status;
  v_expires_at    timestamptz;
  v_total         numeric(10,2);
  v_count         integer;
BEGIN
  IF p_line_items IS NULL
     OR jsonb_typeof(p_line_items) <> 'array'
     OR jsonb_array_length(p_line_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_line_items');
  END IF;

  -- ── Unlocked pre-read: find the parent. Takes no lock, decides nothing.
  -- work_order_id is set at insert and never updated, so it is stable to read
  -- unlocked; every value acted on is re-read under FOR UPDATE below.
  SELECT id, org_id, work_order_id
    INTO v_qr_id, v_org_id, v_work_order_id
    FROM public.quote_requests
   WHERE quote_token = p_quote_token;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- ── 1. PARENT FIRST (see the lock-order note above) ─────────────────────
  PERFORM 1 FROM public.work_orders
   WHERE id = v_work_order_id
     FOR UPDATE;

  -- ── 2. Then the quote, authoritatively, under its own lock ──────────────
  SELECT status, quote_token_expires_at
    INTO v_status, v_expires_at
    FROM public.quote_requests
   WHERE id = v_qr_id
     FOR UPDATE;

  IF v_status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', v_status);
  END IF;

  -- Absent or past ⇒ expired. A quote request with no usable expiry is
  -- malformed, not eternal — the same rule isQuoteTokenExpired() applies in
  -- the route, restated here because this function is the actual writer.
  IF v_expires_at IS NULL OR v_expires_at < now() THEN
    UPDATE public.quote_requests SET status = 'expired' WHERE id = v_qr_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  -- line_total is DELIBERATELY absent from this column list: it is GENERATED
  -- ALWAYS AS (quantity * unit_cost) STORED, and naming it raises 428C9 —
  -- which rejects the WHOLE statement, not just that column. That defect
  -- shipped twice in this codebase (vendor line items, crew scoring signals).
  INSERT INTO public.quote_request_line_items (
    quote_request_id, org_id, line_type, description,
    quantity, unit, unit_cost, sort_order
  )
  SELECT
    v_qr_id,
    v_org_id,
    COALESCE(NULLIF(item->>'line_type', ''), 'material')::line_item_type,
    btrim(item->>'description'),
    (item->>'quantity')::numeric,
    NULLIF(btrim(COALESCE(item->>'unit', '')), ''),
    (item->>'unit_cost')::numeric,
    (ord - 1)::smallint
  FROM jsonb_array_elements(p_line_items) WITH ORDINALITY AS t(item, ord);

  SELECT COALESCE(SUM(line_total), 0), COUNT(*)
    INTO v_total, v_count
    FROM public.quote_request_line_items
   WHERE quote_request_id = v_qr_id;

  -- Bounded here rather than only in the route, because the route validates
  -- items individually and a total is not a property of any single item: 400
  -- lines of $9,999 each is 400 valid items and a $4M quote. Raising rather
  -- than returning rolls back the inserts above in the same breath.
  IF v_total > p_max_total THEN
    RAISE EXCEPTION 'quote total % exceeds maximum %', v_total, p_max_total
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.quote_requests
     SET status        = 'submitted',
         quoted_amount = v_total,
         quote_notes   = NULLIF(btrim(p_notes), ''),
         submitted_at  = now()
   WHERE id = v_qr_id;

  INSERT INTO public.work_order_updates (
    work_order_id, org_id, updated_via_vendor_portal,
    status_from, status_to, notes
  ) VALUES (
    v_work_order_id, v_org_id, true, NULL, NULL,
    'Vendor submitted quote: $' || to_char(v_total, 'FM999999990.00')
      || ' across ' || v_count || ' line item' || CASE WHEN v_count = 1 THEN '' ELSE 's' END
      || COALESCE(' — ' || NULLIF(btrim(p_notes), ''), '')
  );

  RETURN jsonb_build_object(
    'ok',              true,
    'quote_request_id', v_qr_id,
    'work_order_id',   v_work_order_id,
    'org_id',          v_org_id,
    'quoted_amount',   v_total,
    'line_item_count', v_count
  );
END;
$$;

-- The caller is an unauthenticated vendor holding a token; only the service
-- role may reach this, and only through the token route.
REVOKE EXECUTE ON FUNCTION public.submit_quote_via_token(text, jsonb, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.submit_quote_via_token(text, jsonb, text, numeric)
  TO service_role;

NOTIFY pgrst, 'reload schema';
