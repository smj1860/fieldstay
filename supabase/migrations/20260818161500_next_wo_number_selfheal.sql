-- 20260818161500_next_wo_number_selfheal.sql
-- ============================================================================
-- WORK ORDER CREATION WAS PERMANENTLY BROKEN FOR ANY ORG WHOSE COUNTER ROW
-- WAS MISSING OR BEHIND.
--
-- Reproduced against production 2026-08-18 as the affected user, under RLS:
--
--   INSERT INTO work_orders (...) VALUES (...)
--   -> 23505: duplicate key value violates unique constraint
--             "work_orders_org_wo_number_unique"
--
-- The org had 29 work orders numbered WO-2026-0001 .. WO-2026-0029 and NO row
-- in wo_number_counters at all. next_wo_number() did:
--
--   INSERT INTO wo_number_counters VALUES (p_org_id, 1, year)
--   ON CONFLICT (org_id) DO UPDATE SET last_number = last_number + 1
--
-- With no existing row the INSERT branch wins and hands back 1 — i.e.
-- WO-2026-0001, which is already taken. And because the trigger's counter
-- write happens in the SAME TRANSACTION as the failing work_orders insert, it
-- rolls back with it. The counter row is never created, so the next attempt
-- starts from 1 again. Not intermittent: every work order that org ever tries
-- to create fails, forever, and the PM sees only "Operation failed. Please try
-- again."
--
-- How an org gets into that state: its work orders were created with EXPLICIT
-- wo_number values. assign_wo_number only fires when wo_number IS NULL, so a
-- seed, an import or a backfill that supplies its own numbers never advances
-- the counter — and nothing reconciles the two afterwards.
--
-- THE FIX: stop treating wo_number_counters as the sole source of truth and
-- derive the floor from the work orders that actually exist. The counter stays
-- (it is what makes the common path a single indexed upsert rather than a scan
-- and a write), but it can no longer hand back a number that is already taken.
--
-- GREATEST() is applied on BOTH branches on purpose:
--   * the INSERT branch fixes the missing-counter case above;
--   * the DO UPDATE branch fixes a counter that has drifted BEHIND the data,
--     which is the same defect arriving by a different route (a restore, a
--     manual insert, a partially-applied backfill).
--
-- Concurrency: INSERT .. ON CONFLICT DO UPDATE takes a row lock on the counter,
-- so concurrent callers for one org serialise there. The MAX() read sits
-- outside that lock, but because last_number only ever moves forward —
-- GREATEST of its own increment and the observed floor — two concurrent callers
-- still receive distinct, increasing numbers.
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
  -- there. LIKE on the year prefix keeps this on
  -- work_orders_org_wo_number_unique (org_id, wo_number) rather than scanning,
  -- and excludes any row whose wo_number does not match the format at all.
  SELECT COALESCE(
           MAX(NULLIF(regexp_replace(wo_number, '^WO-\d{4}-', ''), '')::integer),
           0
         )
    INTO v_used
    FROM work_orders
   WHERE org_id = p_org_id
     AND wo_number LIKE v_prefix || '%';

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
  'actually exist rather than trusting wo_number_counters alone — a missing or '
  'behind counter used to make every insert collide with '
  'work_orders_org_wo_number_unique, permanently.';

-- ── Backfill the counters that are already wrong ────────────────────────────
--
-- The function above self-heals on the next insert, but only for the year it
-- is called in, and only once someone tries. Correcting the stored counters
-- now means the ledger is consistent immediately rather than on next use, and
-- makes the broken state visible as fixed rather than latent.
--
-- Idempotent: re-running changes nothing once the counters are at or above the
-- observed maximum.
INSERT INTO wo_number_counters (org_id, last_number, current_year)
SELECT w.org_id,
       MAX(NULLIF(regexp_replace(w.wo_number, '^WO-\d{4}-', ''), '')::integer),
       EXTRACT(YEAR FROM NOW())::smallint
  FROM work_orders w
 WHERE w.wo_number LIKE 'WO-' || EXTRACT(YEAR FROM NOW())::smallint || '-%'
 GROUP BY w.org_id
ON CONFLICT (org_id) DO UPDATE
  SET last_number  = GREATEST(wo_number_counters.last_number, EXCLUDED.last_number),
      current_year = EXCLUDED.current_year;
