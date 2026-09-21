-- ============================================================================
-- next_wo_number()'s self-heal floor query is poisoned by a single
-- non-numeric suffix, reintroducing the exact "every work order this org
-- ever tries to create fails, forever" failure 20260818161500_next_
-- wo_number_selfheal.sql was written to close — just via a different route.
--
-- The floor query:
--
--   SELECT COALESCE(
--            MAX(NULLIF(regexp_replace(wo_number, '^WO-\d{4}-', ''), '')::integer),
--            0
--          )
--     FROM work_orders
--    WHERE org_id = p_org_id
--      AND wo_number LIKE v_prefix || '%';
--
-- `wo_number LIKE v_prefix || '%'` only requires the PREFIX to match — the
-- rest of the string can be anything. `regexp_replace(...)` then strips just
-- the prefix and casts whatever remains to integer. That is fine for
-- "WO-2026-0029", and an uncaught error for "WO-2026-URGENT",
-- "WO-2026-0007b", or any other hand-typed or imported wo_number that merely
-- STARTS with the right prefix — `'URGENT'::integer` raises
-- invalid_text_representation, and because this is one aggregate over every
-- matching row in one statement, that single row poisons the MAX() for the
-- ENTIRE org. next_wo_number() runs from assign_wo_number's BEFORE INSERT
-- trigger on every work order creation with wo_number IS NULL, so this is not
-- a one-off failure — it breaks every future work order for that org until
-- the poisoning row's wo_number is corrected by hand.
--
-- 20260818161500's own header names EXACTLY how an org acquires such a row:
-- "its work orders were created with EXPLICIT wo_number values" — a seed, an
-- import, or a backfill — the same path that produces a missing-counter org
-- can just as easily produce a non-numeric-suffix one, and nothing before
-- this fix distinguished the two.
--
-- Fix: replace the loose LIKE with a regex requiring the ENTIRE remainder to
-- be digits — `wo_number ~ ('^' || v_prefix || '\d+$')`. A row that doesn't
-- match is simply excluded from the aggregate, the same as any other
-- non-matching row; Postgres's `~` operator never raises on a non-match, only
-- `::integer` on a non-numeric string does. This is what actually needs to
-- change — regexp_replace + NULLIF + ::integer stays, now only ever reached
-- by rows the WHERE clause has already proven are purely numeric.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.next_wo_number(p_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_year   smallint := EXTRACT(YEAR FROM NOW())::smallint;
  v_prefix text     := 'WO-' || v_year || '-';
  v_used   integer;
  v_number integer;
BEGIN
  -- The highest number this org has actually used THIS YEAR, however it got
  -- there. The regex requires the FULL string to be the prefix followed by
  -- digits and nothing else, so a wo_number that merely starts with the
  -- prefix but carries a non-numeric or extra-character suffix is excluded
  -- from the aggregate rather than raising and poisoning it.
  SELECT COALESCE(
           MAX(NULLIF(regexp_replace(wo_number, '^WO-\d{4}-', ''), '')::integer),
           0
         )
    INTO v_used
    FROM work_orders
   WHERE org_id = p_org_id
     AND wo_number ~ ('^' || v_prefix || '\d+$');

  INSERT INTO wo_number_counters (org_id, last_number, current_year)
  VALUES (p_org_id, v_used + 1, v_year)
  ON CONFLICT (org_id) DO UPDATE
    SET last_number  = GREATEST(
                         CASE
                           WHEN wo_number_counters.current_year = v_year
                           THEN wo_number_counters.last_number + 1
                           ELSE 1
                         END,
                         v_used + 1
                       ),
        current_year = v_year
  RETURNING last_number INTO v_number;

  RETURN 'WO-' || v_year || '-' || LPAD(v_number::text, 4, '0');
END;
$function$;

COMMENT ON FUNCTION public.next_wo_number(uuid) IS
  'Next work order number for an org. Derives a floor from the work orders that '
  'actually exist rather than trusting wo_number_counters alone. The floor '
  'query requires the full wo_number to be the year prefix followed by digits '
  'and nothing else (~ regex, not LIKE) — a wo_number that merely starts with '
  'the prefix but has a non-numeric suffix (a hand-typed or imported value) is '
  'excluded rather than raising invalid_text_representation and poisoning the '
  'MAX() for the whole org.';
