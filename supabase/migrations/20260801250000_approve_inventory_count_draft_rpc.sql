-- ============================================================================
-- approveInventoryCount becomes one transaction, and claims before it writes.
--
-- The server action did: read the draft, apply every counted quantity to
-- inventory_items (one UPDATE per item, in a Promise.all, with every result
-- discarded), and only THEN mark the draft approved. Four problems:
--
--   1. It applied the quantities BEFORE claiming the draft, with no status
--      guard on the claim. Two approvals of the same draft — a double-click,
--      or an approve racing a reject — both applied. Worse, a draft already
--      REJECTED could be approved, silently overwriting live stock counts a
--      PM had deliberately thrown away.
--   2. The claim had no `.eq('status', ...)` precondition at all, so the
--      status write was last-writer-wins between concurrent reviewers.
--   3. When the claim failed, the action returned 'Draft not found' — but the
--      quantities were already written. The PM saw an error and got the write
--      anyway.
--   4. The per-item UPDATEs discarded their results (both the error and the
--      row count). An RLS denial or a bad id applied nothing and reported
--      success, and the loop was N round-trips for an N-item count.
--
-- All four collapse into one statement pair inside one function body: a
-- conditional claim that is the concurrency token, then a single set-based
-- UPDATE ... FROM that applies every item at once. If the claim matches no
-- row, NOTHING is written and the caller is told why.
--
-- first_count_recorded_at is now COALESCE'd in the same statement rather than
-- pre-read into a Set — the read that fed that Set was itself an unbounded
-- `.in()` select, so a count of more than 1000 items silently stopped stamping
-- it past the cap.
--
-- SECURITY DEFINER, so RLS does not apply inside the body: the explicit
-- p_org_id predicate on BOTH statements is the tenant boundary. The caller
-- passes membership.org_id from requireOrgRole(['admin','manager']), never a
-- client-supplied value. Note the draft-items join is safe without its own
-- org column (it has none) because it is anchored to p_draft_id, which was
-- already proven to belong to p_org_id by the claim above.
-- ============================================================================

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
  v_claimed integer := 0;
  v_applied integer := 0;
BEGIN
  -- The claim IS the lock. Exactly one concurrent approval can match a
  -- pending_review row; the loser matches nothing and applies nothing.
  UPDATE public.inventory_count_drafts
     SET status      = 'approved',
         reviewed_at = now(),
         reviewed_by = p_reviewer
   WHERE id     = p_draft_id
     AND org_id = p_org_id
     AND status = 'pending_review';
  GET DIAGNOSTICS v_claimed = ROW_COUNT;

  IF v_claimed = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_claimable');
  END IF;

  UPDATE public.inventory_items i
     SET current_quantity        = d.counted_qty,
         first_count_recorded_at = COALESCE(i.first_count_recorded_at, now()),
         updated_at              = now()
    FROM public.inventory_count_draft_items d
   WHERE d.draft_id = p_draft_id
     AND i.id       = d.item_id
     AND i.org_id   = p_org_id;
  GET DIAGNOSTICS v_applied = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'applied', v_applied);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.approve_inventory_count_draft(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.approve_inventory_count_draft(uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
