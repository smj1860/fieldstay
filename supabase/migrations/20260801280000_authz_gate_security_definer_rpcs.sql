-- ============================================================================
-- SECURITY: SECURITY DEFINER functions were reachable directly over PostgREST
-- with a caller-supplied tenant id and no authorization check.
--
-- Any function in `public` with EXECUTE granted to `authenticated` is exposed
-- at /rest/v1/rpc/<name>. A signed-in user — of ANY org, or of no org — can
-- call it with arguments of their choosing. SECURITY DEFINER disables RLS
-- inside the body, so for these functions the ONLY tenant boundary was the
-- `p_org_id` argument itself, which the attacker supplies.
--
-- The four RPCs added on 2026-08-01 each carry a header comment asserting the
-- boundary holds because "the caller passes membership.org_id from
-- requireOrgMember(), never a client-supplied value." That is true of the
-- server action, and irrelevant: the server action is not the only caller.
-- The GRANT on the last line of each of those migrations is.
--
-- Verified on production before writing this: all four are prosecdef = true,
-- has_function_privilege('authenticated', …, 'EXECUTE') = true, and none of
-- their bodies reference is_org_member / get_user_org_ids / auth.uid /
-- auth.role.
--
-- Worst case was approve_quote_request: given a foreign quote_request_id and
-- org_id it would assign a vendor to another tenant's work order, set
-- portal_enabled = true, and write an ATTACKER-CHOSEN completion_token — the
-- sole credential for the public vendor route, which then lets the attacker
-- close that work order and mint an invoice against it.
--
-- The correct pattern already existed in this codebase, added 2026-07-31 by
-- 20260731201000_role_gate_property_door_code_rpcs.sql: raise 42501 unless the
-- caller is service_role or a member of the org being acted on. These four
-- shipped a day later without it. Applying it here.
--
-- Also closes three PRE-EXISTING functions granted to `authenticated` by
-- 20260707141631_security_definer_execute_grants.sql:
--
--   get_repeat_issues(timestamptz)  — SELECT over work_orders with NO tenant
--   get_asset_repair_summary()        predicate at all. Confirmed live: calling
--                                     these as role `authenticated` returns
--                                     rows spanning THREE distinct orgs,
--                                     including actual_cost sums. A pure
--                                     cross-tenant read, and it also hands an
--                                     attacker the org_id/property_id UUIDs
--                                     needed to exploit the four above.
--   next_wo_number(uuid)            — lets any authenticated user advance
--                                     another org's WO number sequence.
--
-- All three have ZERO callers in app/ or lib/. They are revoked rather than
-- dropped: revoking fully closes the exposure and is reversible, whereas a
-- DROP cannot be verified safe against surfaces outside this repo (edge
-- functions, dashboards, external tooling). They should be dropped once that
-- is confirmed.
-- ============================================================================

-- ── The four 2026-08-01 RPCs: gate, don't revoke ────────────────────────────
-- These ARE called by server actions through the RLS-enforced authenticated
-- client, so the grant must stay. What they were missing is the check.

CREATE OR REPLACE FUNCTION public.remove_crew_from_turnover(
  p_turnover_id    uuid,
  p_crew_member_id uuid,
  p_org_id         uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status    turnover_status;
  v_deleted   integer := 0;
  v_remaining integer := 0;
  v_reverted  boolean := false;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_status
    FROM public.turnovers
   WHERE id = p_turnover_id AND org_id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'turnover_not_found');
  END IF;

  DELETE FROM public.turnover_assignments
   WHERE turnover_id = p_turnover_id AND crew_member_id = p_crew_member_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'assignment_not_found');
  END IF;

  SELECT count(*) INTO v_remaining
    FROM public.turnover_assignments WHERE turnover_id = p_turnover_id;

  IF v_remaining = 0 AND v_status = 'assigned' THEN
    UPDATE public.turnovers SET status = 'pending_assignment'
     WHERE id = p_turnover_id AND org_id = p_org_id;
    v_reverted := true;
  END IF;

  RETURN jsonb_build_object('ok', true, 'remaining', v_remaining, 'reverted', v_reverted);
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_inventory_count_draft(
  p_draft_id uuid,
  p_org_id   uuid,
  p_reviewer uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed     integer := 0;
  v_applied     integer := 0;
  v_expected    integer := 0;
  v_property_id uuid;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  -- RETURNING the property: the apply below is scoped to it, not just to the
  -- org. app/api/crew/inventory-count/route.ts builds inventory_count_draft_items
  -- straight from the client-supplied `counts` map with NO check that each item
  -- id belongs to the property being counted, and writes through the crew
  -- service client, so RLS never sees it either. Without this predicate a crew
  -- member counting property A could have arbitrary SAME-ORG item ids applied
  -- to live stock at property B the moment a PM approves. The org predicate
  -- blocks cross-tenant; it does not block cross-property.
  UPDATE public.inventory_count_drafts
     SET status = 'approved', reviewed_at = now(), reviewed_by = p_reviewer
   WHERE id = p_draft_id AND org_id = p_org_id AND status = 'pending_review'
  RETURNING property_id INTO v_property_id;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;

  IF v_claimed = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_claimable');
  END IF;

  SELECT count(*) INTO v_expected
    FROM public.inventory_count_draft_items WHERE draft_id = p_draft_id;

  UPDATE public.inventory_items i
     SET current_quantity        = d.counted_qty,
         first_count_recorded_at = COALESCE(i.first_count_recorded_at, now()),
         updated_at              = now()
    FROM public.inventory_count_draft_items d
   WHERE d.draft_id    = p_draft_id
     AND i.id          = d.item_id
     AND i.org_id      = p_org_id
     AND i.property_id = v_property_id;
  GET DIAGNOSTICS v_applied = ROW_COUNT;

  -- `expected` is returned so the caller can tell a fully-applied approval
  -- from a partial one. Previously `applied` was discarded entirely, so a
  -- draft whose item ids no longer resolved was marked approved with a subset
  -- — or zero — quantities written, and the PM saw plain success.
  RETURN jsonb_build_object('ok', true, 'applied', v_applied, 'expected', v_expected);
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_inventory_counts(
  p_org_id uuid,
  p_counts jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_applied integer := 0;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  UPDATE public.inventory_items i
     SET current_quantity        = c.qty,
         first_count_recorded_at = COALESCE(i.first_count_recorded_at, now()),
         updated_at              = now()
    FROM jsonb_to_recordset(p_counts) AS c(item_id uuid, qty integer)
   WHERE i.id = c.item_id AND i.org_id = p_org_id;
  GET DIAGNOSTICS v_applied = ROW_COUNT;

  RETURN v_applied;
END;
$$;

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

  SELECT work_order_id, vendor_id, quoted_amount, status
    INTO v_work_order_id, v_vendor_id, v_quoted, v_qr_status
    FROM public.quote_requests
   WHERE id = p_quote_request_id AND org_id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quote_not_found');
  END IF;

  IF v_qr_status <> 'submitted' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_submitted');
  END IF;

  SELECT status INTO v_wo_status
    FROM public.work_orders
   WHERE id = v_work_order_id AND org_id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'work_order_not_found');
  END IF;

  -- The work order's own status was never checked, so an approval could
  -- RESURRECT a cancelled or completed work order: deleteWorkOrder sets
  -- status='cancelled' without settling that WO's quote_requests, and
  -- app/api/work-orders/[token]/quote/route.ts lets a vendor submit a quote
  -- regardless of WO status. Cancel a WO, let a vendor submit, approve — and
  -- the WO goes back to 'assigned' with a live vendor, portal_enabled and a
  -- fresh completion token.
  IF v_wo_status IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'work_order_not_assignable');
  END IF;

  UPDATE public.quote_requests SET status = 'approved' WHERE id = p_quote_request_id;

  UPDATE public.quote_requests
     SET status = 'declined'
   WHERE work_order_id = v_work_order_id
     AND org_id        = p_org_id
     AND id           <> p_quote_request_id
     AND status IN ('pending', 'submitted');
  GET DIAGNOSTICS v_declined = ROW_COUNT;

  UPDATE public.work_orders
     SET vendor_id                   = v_vendor_id,
         status                      = 'assigned',
         estimated_cost              = COALESCE(v_quoted, estimated_cost),
         portal_enabled              = true,
         completion_token            = p_completion_token,
         completion_token_expires_at = p_token_expires_at
   WHERE id = v_work_order_id AND org_id = p_org_id;

  INSERT INTO public.work_order_updates (
    work_order_id, org_id, updated_via_vendor_portal, status_from, status_to, notes
  ) VALUES (
    v_work_order_id, p_org_id, false, v_wo_status, 'assigned',
    'Quote approved — $' || COALESCE(to_char(v_quoted, 'FM999999990.00'), '?')
      || '. Vendor assigned and notified.'
  );

  RETURN jsonb_build_object(
    'ok', true, 'work_order_id', v_work_order_id, 'vendor_id', v_vendor_id,
    'quoted_amount', v_quoted, 'declined', v_declined
  );
END;
$$;

-- ── The three pre-existing unguarded functions: revoke ──────────────────────
-- Zero callers in app/ or lib/. service_role retains access.

REVOKE EXECUTE ON FUNCTION public.get_repeat_issues(timestamptz)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_asset_repair_summary()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.next_wo_number(uuid)             FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
