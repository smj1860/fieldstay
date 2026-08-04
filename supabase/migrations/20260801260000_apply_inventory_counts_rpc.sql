-- ============================================================================
-- submitInventoryCount's per-item UPDATE loop becomes one statement.
--
-- The PM-side count submission applied every counted quantity with one UPDATE
-- per item inside a Promise.all, and discarded every result:
--
--   await Promise.all(updates.map(u =>
--     supabase.from('inventory_items').update({...}).eq('id', u.id).eq('org_id', ...)))
--
-- Nothing checked the error and nothing checked the row count, so an RLS
-- denial, a bad item id, or a partial failure applied some subset of the
-- count and reported complete success — leaving stock numbers that look
-- freshly counted but are a mix of new and stale values, which is worse than
-- a visible failure because nobody re-counts.
--
-- It was also N round-trips for an N-item count (a full property count is
-- routinely 60–120 items), and the first_count_recorded_at Set it depended on
-- came from an unbounded `.in()` select that truncated at max_rows = 1000.
--
-- One set-based statement fixes all three: it is atomic, it reports how many
-- rows it actually touched, and COALESCE handles first_count_recorded_at
-- inline with no pre-read at all.
--
-- SECURITY DEFINER, so RLS does not apply inside the body: the explicit
-- p_org_id predicate IS the tenant boundary. The caller passes
-- membership.org_id from requireOrgMember(), never a client-supplied value —
-- and note the item ids DO come from the client (they are form field names),
-- which is exactly why the org predicate has to be on the UPDATE rather than
-- trusted from the payload.
-- ============================================================================

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
  UPDATE public.inventory_items i
     SET current_quantity        = c.qty,
         first_count_recorded_at = COALESCE(i.first_count_recorded_at, now()),
         updated_at              = now()
    FROM jsonb_to_recordset(p_counts) AS c(item_id uuid, qty integer)
   WHERE i.id     = c.item_id
     AND i.org_id = p_org_id;
  GET DIAGNOSTICS v_applied = ROW_COUNT;

  RETURN v_applied;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_inventory_counts(uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.apply_inventory_counts(uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
