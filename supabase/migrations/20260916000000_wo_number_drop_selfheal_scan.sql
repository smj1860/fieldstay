-- ============================================================================
-- [CATASTROPHIC] Work-order numbering serializes ALL WO creation for an org
-- behind a full-table regex scan, held under an org-wide advisory lock.
--
-- Current shape (20260915214000_sql_logic_concurrency_b2.sql +
-- 20260915155000_next_wo_number_selfheal_regex_guard.sql):
--
--   assign_wo_number()  -- BEFORE INSERT trigger, runs on EVERY work_orders row
--     PERFORM pg_advisory_xact_lock(hashtext(NEW.org_id::text));  -- unconditional
--     IF NEW.wo_number IS NULL THEN
--       NEW.wo_number := next_wo_number(NEW.org_id);
--         -- next_wo_number() does, WHILE THE ADVISORY LOCK IS HELD:
--         --   SELECT MAX(NULLIF(regexp_replace(wo_number, '^WO-\d{4}-', ''), '')::integer)
--         --     FROM work_orders
--         --    WHERE org_id = p_org_id AND wo_number ~ ('^WO-' || v_year || '-\d+$')
--         -- i.e. a regex-filtered scan of EVERY work order this org has EVER
--         -- created (for the current year), on every single insert.
--     END IF;
--
-- At 10M work_orders rows for a busy org, that scan runs — under a lock that
-- blocks every OTHER concurrent work-order insert for the same org — on
-- every work order any crew member or PM creates. This is the single
-- highest-severity finding in the scalability audit: WO creation is a
-- constant, high-frequency write path (crew flags, maintenance-schedule
-- auto-creation, PM manual creation), and this makes it serialize per-org
-- with O(n) work per insert instead of O(1).
--
-- FIX, exactly as the audit recommends: drop the self-heal SELECT MAX scan
-- entirely. Trust wo_number_counters's own row as the sole source of truth,
-- and rely on the ROW-LEVEL LOCK that `INSERT ... ON CONFLICT (org_id) DO
-- UPDATE ... RETURNING` already takes on that single counter row — not the
-- org-wide advisory lock, which is now removed too, since nothing left needs
-- it (see below).
--
-- ── What self-healing bought, and what removing it costs ───────────────────
--
-- The self-heal scan was added by 20260818161500_next_wo_number_selfheal.sql
-- to fix a real, reproduced-in-production bug: an org whose wo_number_counters
-- row was missing or behind (because some of its work orders were created
-- with an EXPLICIT wo_number — a seed, an import, or a backfill that never
-- went through this trigger) got `23505 duplicate key` on every single WO
-- creation, forever, because `next_wo_number()` had no way to know the
-- counter didn't reflect reality.
--
-- Removing the scan removes that safety net. From this migration forward:
--
--   * A NEW org (no wo_number_counters row) with any pre-existing work orders
--     that were inserted with an explicit wo_number will NOT be protected —
--     next_wo_number() starts counting from 1 again and can collide with an
--     existing WO-<year>-0001..NNNN the moment it's reached.
--   * A counter that drifts BEHIND the data by some OTHER route (a restore,
--     a manual wo_number_counters edit, a partially-applied backfill) is no
--     longer corrected automatically. It will manifest the same way the
--     original 20260818161500 bug did: `23505` on every insert for that org,
--     until someone manually corrects the wo_number_counters row.
--
-- This trade is deliberate and matches the audit's own recommendation: the
-- self-heal scan is an O(n)-per-insert tax paid by EVERY org, EVERY insert,
-- forever, to guard against a failure mode (an explicit-wo_number write that
-- bypasses the trigger) that is rare, already fully avoidable at the write
-- site (never supply wo_number explicitly outside a deliberate, reviewed
-- backfill), and — per 20260818161500's own header — was reproduced exactly
-- ONCE, for an org onboarded via a path this codebase no longer uses. Any
-- future backfill or import that assigns explicit wo_number values MUST also
-- upsert wo_number_counters.last_number to at least the highest number it
-- wrote, in the SAME migration/script — that discipline, not a per-insert
-- scan, is what keeps the counter authoritative going forward.
--
-- ── Why the advisory lock in assign_wo_number() goes too ────────────────────
--
-- 20260915214000 added `pg_advisory_xact_lock(hashtext(NEW.org_id::text))`,
-- taken UNCONDITIONALLY (even for explicit-numbered inserts), specifically
-- to close a TOCTOU against the self-heal scan: an explicit-numbered insert
-- landing between the scan's read and the eventual auto-numbered insert's
-- commit could mint a number that then collided. With the scan itself gone,
-- that TOCTOU no longer exists — there is nothing left for the advisory lock
-- to protect against, since `next_wo_number()` no longer reads work_orders at
-- all. The ON CONFLICT upsert on wo_number_counters already gives correct,
-- serialized, monotonically-increasing numbers for concurrent auto-numbered
-- inserts on its own (Postgres row locking on the counter row), with no
-- org-wide lock and no work_orders scan involved.
--
-- Net effect: work-order creation for one org no longer serializes against
-- itself at all (beyond the single-row lock on that org's own counter row,
-- held for a handful of nanoseconds), and never touches work_orders itself
-- during numbering.
--
-- Format is UNCHANGED: 'WO-' || year || '-' || zero-padded 4-digit counter,
-- e.g. WO-2026-0001. Nothing about the customer-visible number format
-- changes here — only how the next integer is derived.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.next_wo_number(p_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_year   smallint := EXTRACT(YEAR FROM NOW())::smallint;
  v_number integer;
BEGIN
  -- Sole source of truth: wo_number_counters. No read of work_orders at all
  -- — the self-heal MAX() scan is deliberately removed (see header comment).
  -- The INSERT ... ON CONFLICT takes a row-level lock on THIS org's counter
  -- row only, which is what actually serializes concurrent callers for the
  -- same org — not the advisory lock, which no longer exists.
  INSERT INTO wo_number_counters (org_id, last_number, current_year)
  VALUES (p_org_id, 1, v_year)
  ON CONFLICT (org_id) DO UPDATE
    SET last_number  = CASE
                         WHEN wo_number_counters.current_year = v_year
                         THEN wo_number_counters.last_number + 1
                         ELSE 1
                       END,
        current_year = v_year
  RETURNING last_number INTO v_number;

  RETURN 'WO-' || v_year || '-' || LPAD(v_number::text, 4, '0');
END;
$function$;

COMMENT ON FUNCTION public.next_wo_number(uuid) IS
  'Next work order number for an org. wo_number_counters is the SOLE source '
  'of truth — the prior self-heal SELECT MAX(...) FROM work_orders scan was '
  'deliberately removed (20260916000000_wo_number_drop_selfheal_scan.sql): it '
  'ran, regex-filtered, over every work order the org has ever created, on '
  'every single insert, which does not scale. A counter that is missing or '
  'behind (e.g. from a backfill/import that supplied explicit wo_number '
  'values without also advancing this counter) is NOT self-corrected anymore '
  '— that backfill/import must upsert wo_number_counters.last_number itself, '
  'in the same script, or every subsequent auto-numbered insert for that org '
  'will collide with work_orders_org_wo_number_unique.';

-- The trigger function. The advisory lock is REMOVED — it existed only to
-- close a TOCTOU against next_wo_number()'s now-removed self-heal scan (see
-- header comment). With that scan gone, an explicit-numbered insert and a
-- concurrent auto-numbered one no longer need to serialize against each
-- other at all: the auto-numbered path never reads work_orders, so it cannot
-- observe (or race against) an explicit-numbered insert's wo_number.
CREATE OR REPLACE FUNCTION public.assign_wo_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.wo_number IS NULL THEN
    NEW.wo_number := next_wo_number(NEW.org_id);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.assign_wo_number() IS
  'BEFORE INSERT trigger on work_orders. No advisory lock — removed in '
  '20260916000000_wo_number_drop_selfheal_scan.sql along with '
  'next_wo_number()''s self-heal scan it existed to protect. Concurrency for '
  'auto-numbered inserts is handled entirely by the row-level lock '
  'INSERT ... ON CONFLICT takes on wo_number_counters inside next_wo_number().';

-- No grant changes: assign_wo_number remains un-grantable (trigger functions
-- are not reachable via PostgREST and need no EXECUTE grant), and
-- next_wo_number() keeps whatever grants 20260801290000 already established
-- (SECURITY DEFINER lets the trigger's caller-privilege context reach it
-- without a caller-side grant).

NOTIFY pgrst, 'reload schema';
