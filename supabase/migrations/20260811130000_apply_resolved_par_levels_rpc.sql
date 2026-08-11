-- PAR pass 2: the write side of the recompute.
--
-- resolvePar() (lib/inventory/par-engine.ts) computes a par per item from the
-- property's bedrooms / bathrooms / max_guests, or from historical consumption
-- once enough samples exist. This is how those results get back into
-- inventory_items.par_level, which the crew PWA, PO generation and the
-- low-stock checks all already read.
--
-- ONE statement for the whole batch, deliberately. The two obvious
-- alternatives are both wrong here:
--
--   * a per-item UPDATE in a loop is the N+1 that
--     unit/guardrails/n-plus-one-loops.test.ts exists to catch, and a
--     recompute touches every smart item on every property in an org — tens of
--     thousands of round trips for a 50-property portfolio.
--   * .upsert() with partial rows FAILS. Postgres validates NOT NULL when it
--     forms the tuple, BEFORE conflict detection, so an upsert carrying only
--     { id, par_level } is rejected against inventory_items' NOT NULL columns
--     (property_id, org_id, name, category, unit) rather than falling through
--     to the UPDATE branch. The original PAR spec used exactly that shape,
--     which would have made the engine inert — every recompute reporting
--     success and changing nothing.
--
-- par_resolved_at is stamped on every matched row, not only the ones whose
-- value moved: it answers "when did we last resolve this", and a row that
-- resolved to the same number was still resolved. The return value counts rows
-- whose par actually CHANGED, which is the number worth logging.
--
-- That split is why this is TWO data-modifying CTEs over disjoint row sets
-- rather than one UPDATE with a RETURNING comparison. In an UPDATE's RETURNING
-- clause the row reference carries the NEW values, so
-- `RETURNING i.par_level IS DISTINCT FROM v.par_level` is always false and the
-- changed-count would silently report 0 forever. Postgres runs a
-- data-modifying CTE exactly once and to completion whether or not the primary
-- query reads it, so both branches fire; their WHERE clauses are mutually
-- exclusive, so no row is touched twice.
--
-- SECURITY INVOKER (the default): inventory_items' own RLS applies, so a PM
-- can only ever move their own org's rows. Inngest calls it with the service
-- role and bypasses RLS as it already does for every other write.
CREATE OR REPLACE FUNCTION public.apply_resolved_par_levels(p_rows jsonb)
RETURNS integer
LANGUAGE sql
AS $$
  WITH v AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
      AS x(id uuid, par_level numeric)
  ),
  changed AS (
    UPDATE public.inventory_items i
       SET par_level       = v.par_level,
           par_resolved_at = now()
      FROM v
     WHERE i.id = v.id
       AND i.par_level IS DISTINCT FROM v.par_level
    RETURNING 1
  ),
  restamped AS (
    UPDATE public.inventory_items i
       SET par_resolved_at = now()
      FROM v
     WHERE i.id = v.id
       AND i.par_level IS NOT DISTINCT FROM v.par_level
    RETURNING 1
  )
  SELECT count(*)::int FROM changed;
$$;

COMMENT ON FUNCTION public.apply_resolved_par_levels(jsonb) IS
  'Writes resolvePar() results back to inventory_items.par_level in one '
  'statement. Returns the count of rows whose par actually changed. Never use '
  '.upsert() for this: NOT NULL is validated before conflict detection, so a '
  'partial-row upsert is rejected outright rather than updating.';

GRANT EXECUTE ON FUNCTION public.apply_resolved_par_levels(jsonb) TO authenticated;
