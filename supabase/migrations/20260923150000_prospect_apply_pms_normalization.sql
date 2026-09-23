-- One statement per chunk for the PMS backfill, instead of one per row.
--
-- The backfill splits prospect_accounts.pms into a canonical product plus the
-- evidence for it in pms_note (lib/prospecting/pms-backfill.ts). 160 live rows
-- carry a crawler fingerprint inline, which is the N+1 shape
-- unit/guardrails/n-plus-one-loops.test.ts exists to catch.
--
-- ── WHY NOT prospect_apply_import_updates ───────────────────────────────────
--
-- That RPC COALESCEs every column against its current value, which is exactly
-- right for an import that only ever fills and refreshes — and exactly wrong
-- here. This operation must be able to set pms to NULL: a cell holding prose
-- rather than a product ("website directs to AirBnB") moves wholesale into
-- pms_note and leaves pms empty, and COALESCE(NULL, a.pms) would silently
-- keep the prose. So this is its own function, assigning directly.
--
-- `->>` yields SQL NULL for a JSON null, so a payload of
-- {"pms": null, "pms_note": "…"} clears the column as intended. Both keys are
-- always present in the payload; there is no "omitted means leave alone" case
-- to confuse with "null means clear".
--
-- The SET list is these two columns and nothing else — the same structural
-- guarantee the import RPC gives: no status, note, contact or scorer column
-- can be written from this path however the payload was built.

CREATE OR REPLACE FUNCTION public.prospect_apply_pms_normalization(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.is_platform_staff_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Rows must be an array.' USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'Too many rows in one chunk (max 500).' USING ERRCODE = '22023';
  END IF;

  WITH patch AS (
    SELECT (e ->> 'id')::uuid AS id,
           e ->> 'pms'        AS pms,
           e ->> 'pms_note'   AS pms_note
      FROM jsonb_array_elements(p_rows) AS e
     WHERE e ? 'pms' AND e ? 'pms_note'
  ),
  updated AS (
    UPDATE public.prospect_accounts a
       SET pms      = patch.pms,
           pms_note = patch.pms_note
      FROM patch
     WHERE a.id = patch.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM updated;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prospect_apply_pms_normalization(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.prospect_apply_pms_normalization(jsonb) TO authenticated;

COMMENT ON FUNCTION public.prospect_apply_pms_normalization(jsonb) IS
  'Applies a chunk of PMS-normalization changes in one statement. Assigns pms
   and pms_note directly rather than COALESCEing, because clearing pms to NULL
   is a required outcome; no other column can be written.';
