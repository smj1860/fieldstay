-- ============================================================================
-- apply_resolved_par_levels(p_rows jsonb) is nondeterministic when p_rows
-- carries two entries for the SAME inventory_items.id.
--
-- Both data-modifying CTEs join `inventory_items i` against `v` with a plain
-- `UPDATE ... FROM v WHERE i.id = v.id`. Postgres's documented behavior for
-- that shape, when more than one row of the FROM clause matches one target
-- row, is: "only one of those rows will be used to update the target row,
-- but it is not specified which one will be used." No error, no signal —
-- just a silently arbitrary choice of which of the two conflicting
-- par_level values actually lands, which can differ between runs, between
-- the changed/restamped branches, or even within the same statement's
-- planner choice on a given day.
--
-- The one known caller (recomputeParLevels, lib/inventory/recompute-par.ts)
-- builds one row per inventory_items.id today and cannot produce a
-- duplicate under normal operation — but this function is
-- `GRANT EXECUTE ... TO authenticated`, SECURITY INVOKER, directly callable
-- by any signed-in caller with a hand-built p_rows, not gated to that one
-- known-safe call site. Its own correctness should not depend on every
-- future caller happening to deduplicate first.
--
-- Fix: deduplicate p_rows by id BEFORE either UPDATE, keeping the LAST
-- occurrence in array order (jsonb_array_elements WITH ORDINALITY gives a
-- real position to order by, which jsonb_to_recordset does not expose) —
-- "whichever value the caller listed last for this id wins" is a
-- well-defined, reproducible outcome regardless of which values happen to
-- collide, closing the ambiguity outright rather than picking a direction
-- that merely happens to look deterministic today.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_resolved_par_levels(p_rows jsonb)
RETURNS integer
LANGUAGE sql
AS $$
  WITH raw AS (
    SELECT
      (elem ->> 'id')::uuid        AS id,
      (elem ->> 'par_level')::numeric AS par_level,
      ord
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  ),
  v AS (
    SELECT DISTINCT ON (raw.id) raw.id, raw.par_level
    FROM raw
    ORDER BY raw.id, raw.ord DESC
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
  'partial-row upsert is rejected outright rather than updating. p_rows is '
  'deduplicated by id (keeping the LAST array occurrence) before either '
  'UPDATE — a duplicate id fed straight into UPDATE...FROM lets Postgres pick '
  'an unspecified matching row, which is silently nondeterministic rather '
  'than an error.';

GRANT EXECUTE ON FUNCTION public.apply_resolved_par_levels(jsonb) TO authenticated;
