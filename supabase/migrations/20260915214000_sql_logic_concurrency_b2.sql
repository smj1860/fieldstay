-- ============================================================================
-- Three independent SQL logic/concurrency fixes from the hostile SQL audit.
--
-- 1. record_consumption_samples(p_rows jsonb) took org_id verbatim from the
--    JSON payload instead of deriving it from inventory_items.org_id. The
--    function is service_role-only so it isn't directly attacker-reachable,
--    but a bug anywhere in the Inngest caller (a stale org_id cached
--    alongside an item id after a property transfer, a copy/paste mismatch
--    assembling the batch) would silently write consumption stats under the
--    wrong tenant — inventory_consumption_stats_select's RLS scopes purely
--    on the stored org_id column, not a join back to the item's real org, so
--    a misattributed row is either invisible to the org that actually owns
--    the item or visible (mislabeled) to a different org's par-explanation
--    UI. Now derives org_id via a join to inventory_items, which also means
--    an inventory_item_id that doesn't exist is silently excluded rather
--    than raising a foreign-key violation that would abort the batch (same
--    "a bad row must not poison the whole call" principle the dedup fix
--    already applies here).
--
-- 2. apply_inventory_counts(p_org_id uuid, p_counts jsonb) had two gaps: (a)
--    the same UPDATE...FROM nondeterminism apply_resolved_par_levels had —
--    a p_counts batch (e.g. a Dexie outbox replay after a flaky reconnect)
--    carrying two entries for the same item_id lets Postgres pick an
--    unspecified one silently; (b) no qty >= 0 check, so a malformed or
--    buggy client payload could store a negative current_quantity, which
--    then feeds directly into the below-par trigger and purchase-order
--    quantity math (quantity_to_buy = par_level - counted), silently
--    inflating cart sizes. Fixed the same way as apply_resolved_par_levels:
--    deduplicate by item_id (last array occurrence wins, via ordinality
--    since jsonb_to_recordset exposes no position) before the UPDATE, and
--    require qty >= 0.
--
-- 3. next_wo_number()'s self-heal floor read (SELECT MAX(...) FROM
--    work_orders) is unlocked. A concurrent transaction that inserts a work
--    order with an EXPLICIT wo_number (an import/backfill — the exact
--    pattern that produces number drift in the first place) between that
--    read and the eventual work_orders insert that consumes the minted
--    number can still claim that number first and commit, so the number
--    this function just handed back collides with
--    work_orders_org_wo_number_unique when the original insert lands.
--    An advisory lock taken ONLY inside next_wo_number() would not close
--    this: assign_wo_number()'s trigger only calls next_wo_number() when
--    NEW.wo_number IS NULL, so an explicit-numbered insert never reaches it
--    and never takes the lock. The lock has to live in the TRIGGER function
--    itself, taken UNCONDITIONALLY before checking wo_number, so an
--    explicit-numbered insert serializes against a concurrent auto-numbered
--    one for the same org — after which the auto-numbered insert's floor
--    read is guaranteed to see the explicit insert if it already committed.
-- ============================================================================

-- 1. record_consumption_samples() — authoritative org_id via join
CREATE OR REPLACE FUNCTION public.record_consumption_samples(p_rows jsonb)
RETURNS integer
LANGUAGE sql
AS $$
  WITH raw AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
      AS x(inventory_item_id uuid, org_id uuid, rate numeric, sampled_at timestamptz)
  ),
  joined AS (
    -- i.org_id is authoritative; raw.org_id (the caller's claim) is ignored.
    -- The INNER JOIN also means an inventory_item_id that doesn't exist is
    -- silently excluded rather than raising an FK violation that would
    -- abort the whole batch.
    SELECT raw.inventory_item_id, i.org_id, raw.rate, raw.sampled_at
    FROM raw
    JOIN public.inventory_items i ON i.id = raw.inventory_item_id
  ),
  v AS (
    SELECT
      joined.inventory_item_id,
      joined.org_id,
      avg(joined.rate)       AS rate,
      max(joined.sampled_at) AS sampled_at
    FROM joined
    GROUP BY joined.inventory_item_id, joined.org_id
  ),
  ins AS (
    INSERT INTO public.inventory_consumption_stats
      (inventory_item_id, org_id, avg_rate_per_guest_night, sample_count, last_sample_at)
    SELECT v.inventory_item_id, v.org_id, v.rate, 1, v.sampled_at
    FROM v
    ON CONFLICT (inventory_item_id) DO UPDATE
      SET avg_rate_per_guest_night =
            (public.inventory_consumption_stats.avg_rate_per_guest_night
               * public.inventory_consumption_stats.sample_count
             + EXCLUDED.avg_rate_per_guest_night)
            / (public.inventory_consumption_stats.sample_count + 1),
          sample_count   = public.inventory_consumption_stats.sample_count + 1,
          last_sample_at = GREATEST(
            COALESCE(public.inventory_consumption_stats.last_sample_at, EXCLUDED.last_sample_at),
            EXCLUDED.last_sample_at
          )
    RETURNING 1
  )
  SELECT count(*)::int FROM ins;
$$;

COMMENT ON FUNCTION public.record_consumption_samples(jsonb) IS
  'Folds consumption observations into inventory_consumption_stats as an '
  'incremental mean, atomically inside ON CONFLICT so concurrent counts cannot '
  'lose a sample. p_rows is deduplicated by (inventory_item_id, org_id) before '
  'the insert — a batch carrying two rows for the same item is averaged into '
  'one rather than raising a cardinality_violation that would abort the whole '
  'batch. org_id is ALWAYS derived from inventory_items via join, never taken '
  'from the payload — a bug in the caller cannot misattribute a sample to the '
  'wrong tenant. rate is per CAPACITY-night (occupied nights x max_guests), '
  'not per actual headcount — bookings has no guest count. resolvePar() '
  'multiplies by the same max_guests, so the proxy cancels.';

GRANT EXECUTE ON FUNCTION public.record_consumption_samples(jsonb) TO service_role;

-- 2. apply_inventory_counts() — dedup by item_id (last wins) + qty >= 0
CREATE OR REPLACE FUNCTION public.apply_inventory_counts(p_org_id uuid, p_counts jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_applied integer := 0;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT is_org_member(p_org_id, ARRAY['admin'::member_role, 'manager'::member_role]) THEN
    RAISE EXCEPTION 'not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  UPDATE public.inventory_items i
     SET current_quantity = c.qty,
         first_count_recorded_at = COALESCE(i.first_count_recorded_at, now()),
         updated_at = now()
    FROM (
      SELECT DISTINCT ON (item_id) item_id, qty
      FROM (
        SELECT (elem ->> 'item_id')::uuid AS item_id,
               (elem ->> 'qty')::numeric  AS qty,
               ord
        FROM jsonb_array_elements(coalesce(p_counts, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      ) raw
      ORDER BY item_id, ord DESC
    ) c
   WHERE i.id = c.item_id AND i.org_id = p_org_id AND c.qty >= 0;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  RETURN v_applied;
END; $function$;

COMMENT ON FUNCTION public.apply_inventory_counts(uuid, jsonb) IS
  'Applies submitted counts to inventory_items.current_quantity. p_counts is '
  'deduplicated by item_id (keeping the LAST array occurrence) before the '
  'UPDATE, same convention as apply_resolved_par_levels — a duplicate item_id '
  'fed straight into UPDATE...FROM lets Postgres pick an unspecified matching '
  'row. Rows with qty < 0 are silently excluded rather than writing a '
  'negative current_quantity, which would otherwise flow straight into the '
  'below-par trigger and purchase-order quantity math.';

-- 3. next_wo_number()'s TOCTOU — the lock has to live in the TRIGGER
-- function (fires on every insert), not inside next_wo_number() itself
-- (only reached when wo_number IS NULL, so an explicit-numbered insert
-- would never take a lock placed there).
CREATE OR REPLACE FUNCTION public.assign_wo_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Unconditional and BEFORE the wo_number check: an explicit-numbered
  -- insert (a backfill/import) must serialize against a concurrent
  -- auto-numbered one for the SAME org, or the auto-numbered insert's floor
  -- read can miss the explicit insert and mint a number that collides with
  -- it moments later. Transaction-scoped — released automatically at
  -- COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.org_id::text));

  IF NEW.wo_number IS NULL THEN
    NEW.wo_number := next_wo_number(NEW.org_id);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.assign_wo_number() IS
  'BEFORE INSERT trigger on work_orders. Takes an advisory lock scoped to '
  'org_id UNCONDITIONALLY, before checking wo_number, so an explicit-numbered '
  'insert (import/backfill) serializes against a concurrent auto-numbered one '
  'for the same org — closing next_wo_number()''s TOCTOU against a concurrent '
  'explicit-numbered insert, which a lock placed only inside next_wo_number() '
  'itself cannot do (that function is only reached when wo_number IS NULL).';
