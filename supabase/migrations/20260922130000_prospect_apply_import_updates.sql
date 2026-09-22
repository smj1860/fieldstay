-- One round trip for a chunk of import updates, instead of one per row.
--
-- The admin import wizard resolves a file against the live table and produces
-- a per-row patch — each row updating a DIFFERENT set of columns, so there is
-- no .in('id', ids) form of the write. Issuing them one at a time is ~3,000
-- round trips for a full master-sheet import, which is the N+1 shape
-- unit/guardrails/n-plus-one-loops.test.ts exists to catch. Same jsonb-in,
-- count-out shape as apply_inventory_counts.
--
-- ── WHY COALESCE AND NOT A COLUMN LIST ──────────────────────────────────────
--
-- The column list is fixed here and every column reads
-- COALESCE(patch->>'col', a.col), so a patch that does not name a column
-- leaves it exactly as it was. That is safe because the planner
-- (lib/prospecting/import.ts) only ever puts NON-NULL values in a patch: an
-- import fills and refreshes, it never blanks. It also means this function is
-- the second, structural enforcement of the writable-column allowlist — a
-- column absent from the SET list below cannot be written by an import
-- however the payload was built.
--
-- `company` is deliberately absent: an import may create a company, never
-- rename one. `status`, `status_note`, `notes`, `next_action_at` and
-- `last_touch_at` are absent for the same reason they are absent from the
-- application allowlist — they are a person's work.

CREATE OR REPLACE FUNCTION public.prospect_apply_import_updates(p_rows jsonb)
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
    SELECT (e ->> 'id')::uuid AS id, e -> 'patch' AS p
      FROM jsonb_array_elements(p_rows) AS e
     WHERE jsonb_typeof(e -> 'patch') = 'object'
  ),
  updated AS (
    UPDATE public.prospect_accounts a SET
      domain                = COALESCE(patch.p ->> 'domain',                a.domain),
      website               = COALESCE(patch.p ->> 'website',               a.website),
      comparent_url         = COALESCE(patch.p ->> 'comparent_url',         a.comparent_url),
      city                  = COALESCE(patch.p ->> 'city',                  a.city),
      state                 = COALESCE(patch.p ->> 'state',                 a.state),
      market                = COALESCE(patch.p ->> 'market',                a.market),
      region                = COALESCE(patch.p ->> 'region',                a.region),
      portfolio_size        = COALESCE((patch.p ->> 'portfolio_size')::integer, a.portfolio_size),
      portfolio_size_method = COALESCE(patch.p ->> 'portfolio_size_method', a.portfolio_size_method),
      pms                   = COALESCE(patch.p ->> 'pms',                   a.pms),
      pms_note              = COALESCE(patch.p ->> 'pms_note',              a.pms_note),
      score_a               = COALESCE((patch.p ->> 'score_a')::integer,    a.score_a),
      score_b               = COALESCE((patch.p ->> 'score_b')::integer,    a.score_b),
      track                 = COALESCE(patch.p ->> 'track',                 a.track),
      bucket                = COALESCE(patch.p ->> 'bucket',                a.bucket),
      gate                  = COALESCE(patch.p ->> 'gate',                  a.gate),
      source                = COALESCE(patch.p ->> 'source',                a.source),
      contact_name          = COALESCE(patch.p ->> 'contact_name',          a.contact_name),
      contact_title         = COALESCE(patch.p ->> 'contact_title',         a.contact_title),
      email                 = COALESCE(patch.p ->> 'email',                 a.email),
      phone                 = COALESCE(patch.p ->> 'phone',                 a.phone),
      linkedin_url          = COALESCE(patch.p ->> 'linkedin_url',          a.linkedin_url)
      -- email_is_generic is GENERATED ALWAYS and must never be named here:
      -- Postgres rejects the WHOLE statement with 428C9, not just that column.
      FROM patch
     WHERE a.id = patch.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM updated;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prospect_apply_import_updates(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.prospect_apply_import_updates(jsonb) TO authenticated;

COMMENT ON FUNCTION public.prospect_apply_import_updates(jsonb) IS
  'Applies a chunk of admin-import patches in one statement. Every column is
   COALESCEd against its current value, so a patch that omits a column leaves
   it alone; company and the funnel columns cannot be written at all.';
