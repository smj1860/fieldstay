-- ============================================================================
-- DEADLOCK: approve_quote_request took its row locks child-first, then reached
-- back for siblings, so two concurrent approvals on the SAME work order could
-- each hold what the other needed.
--
-- The 20260801270000 version locked in this order:
--
--   1. FOR UPDATE the target quote_requests row
--   2. FOR UPDATE the parent work_orders row
--   3. UPDATE the target quote  (already held)
--   4. UPDATE the SIBLING quote_requests rows on the same work order  ← here
--   5. UPDATE the work order   (already held)
--
-- Step 4 is the problem: it takes locks on quote rows this transaction did not
-- lock in step 1. Two PMs approving two different quotes (A and B) on one work
-- order interleave like this:
--
--   session 1                      session 2
--   ─────────────────────────      ─────────────────────────
--   lock QR_A                      lock QR_B
--   lock WO                        wait for WO  (held by s1)
--   step 4: needs QR_B  ───────►   ... which s2 holds
--   ▼ waits on s2                  ▼ waits on s1
--                    DEADLOCK — Postgres kills one with 40P01
--
-- The victim's whole transaction aborts, so nothing is half-written and no
-- data is corrupted; the PM just gets "Operation failed. Please try again."
-- for a reason no log explains. It is a correctness-of-experience bug and a
-- lock-discipline bug, not a data-integrity one.
--
-- FIX: take the PARENT lock first, always. The work order is the object both
-- sessions contend for, so locking it before touching any quote row serialises
-- the two approvals completely — the second waits at step 2 and then observes
-- the first's committed result, instead of proceeding far enough to hold a
-- lock the first still needs. With the work order held, the sibling UPDATE in
-- step 4 can no longer race anything, because no other approval on that work
-- order can be past its own step 2.
--
-- Getting the parent id requires reading the quote first, which is why the
-- pre-read at the top is deliberately NOT `FOR UPDATE`: it exists only to find
-- the work order and to fast-path an already-decided quote without taking any
-- lock at all. Nothing is decided on it. `quote_requests.work_order_id` is set
-- at insert and never updated, so it is stable to read unlocked; every value
-- the function acts on (status, vendor_id, quoted_amount) is re-read under
-- FOR UPDATE at step 3, after the parent lock is held.
--
-- One deliberate behaviour note: when a quote is both non-submitted AND its
-- work order is missing, the unlocked fast path now returns 'not_submitted'
-- where the old code also returned 'not_submitted' — precedence is preserved.
-- If the status flips between the fast path and step 3, step 3's re-check
-- still returns 'not_submitted' and nothing has been written. Both callers
-- (approveQuoteRequest in app/(dashboard)/maintenance/actions.ts) map every
-- reason to its own user-facing message, so no message changes.
--
-- Vendor compliance remains checked in the action ahead of this call, exactly
-- as 20260801270000 documented.
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
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  -- ── Unlocked pre-read: find the parent, and fast-path a decided quote ────
  -- Takes no lock. Only work_order_id is carried forward from here; every
  -- value acted on is re-read under FOR UPDATE below.
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

  -- ── 1. PARENT FIRST. This is the deadlock fix. ──────────────────────────
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

  -- Authoritative check: a concurrent approval that won the work-order lock
  -- may have declined this quote while we waited for it.
  IF v_qr_status <> 'submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_submitted');
  END IF;

  UPDATE public.quote_requests
     SET status = 'approved'
   WHERE id = p_quote_request_id;

  -- Safe now: no other approval on this work order can be past its own
  -- parent-lock step, so these sibling rows cannot be held by a racer.
  UPDATE public.quote_requests
     SET status = 'declined'
   WHERE work_order_id = v_work_order_id
     AND org_id        = p_org_id
     AND id           <> p_quote_request_id
     AND status IN ('pending', 'submitted');
  GET DIAGNOSTICS v_declined = ROW_COUNT;

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
      || '. Vendor assigned and notified.'
  );

  RETURN jsonb_build_object(
    'ok',            true,
    'work_order_id', v_work_order_id,
    'vendor_id',     v_vendor_id,
    'quoted_amount', v_quoted,
    'declined',      v_declined
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.approve_quote_request(uuid, uuid, text, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.approve_quote_request(uuid, uuid, text, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
