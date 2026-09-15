-- ============================================================================
-- record_consumption_samples(p_rows jsonb) aborts the ENTIRE batch when the
-- same inventory_item_id appears twice within one call.
--
-- The function is a single INSERT ... ON CONFLICT (inventory_item_id) DO
-- UPDATE statement over every row in p_rows. Postgres does not allow one
-- INSERT statement to affect the SAME conflict target twice — if p_rows
-- carries two rows for the same inventory_item_id, Postgres raises
-- "ON CONFLICT DO UPDATE command cannot affect row a second time"
-- (SQLSTATE 21000, cardinality_violation) and the WHOLE statement aborts.
-- Every other item's sample in that batch is lost too, not just the
-- duplicated one — a single bad row poisons the entire call.
--
-- THIS IS REACHABLE, not theoretical: inventory_count_items
-- (20260524170119_fieldstay_v1_inventory_pos.sql) has no UNIQUE constraint on
-- (count_id, inventory_item_id) — only a bare id PK. recordConsumptionFromCount
-- (lib/inventory/record-consumption.ts) builds p_rows straight from that
-- table's rows for one count, keyed by inventory_item_id with no dedup of its
-- own, so a count session that happens to carry two rows for the same item
-- (a duplicate row from a client bug, a merge of two templates that both
-- seeded the same catalog item) produces a p_rows batch with a genuine
-- duplicate.
--
-- WORSE THAN A THROWN ERROR: recordConsumptionFromCount claims idempotency
-- BEFORE calling this RPC — inventory_counts.consumption_recorded_at is
-- stamped first, specifically so an Inngest retry of the SAME event is a
-- guaranteed no-op. That claim cannot distinguish "this call already
-- succeeded" from "this call is about to fail on a cardinality violation", so
-- when this RPC throws, the retry that would normally recover sees the claim
-- already burned and silently returns 'already_recorded' — every sample from
-- that submission is lost PERMANENTLY, not just delayed.
--
-- Fix: deduplicate p_rows by (inventory_item_id, org_id) BEFORE the INSERT,
-- averaging the rate of any duplicates and keeping the newest sampled_at —
-- the same "take the newer one" rule the UPDATE branch already applies to
-- last_sample_at. This guarantees the INSERT can never attempt to affect one
-- conflict target twice, regardless of what a caller sends. It costs
-- treating two same-batch duplicate rows as one averaged sample instead of
-- two separate ones (one is folded into the batch's own mean rather than the
-- table's rolling one) — a reasonable data-quality tradeoff against losing
-- the entire batch outright.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_consumption_samples(p_rows jsonb)
RETURNS integer
LANGUAGE sql
AS $$
  WITH raw AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
      AS x(inventory_item_id uuid, org_id uuid, rate numeric, sampled_at timestamptz)
  ),
  v AS (
    SELECT
      raw.inventory_item_id,
      raw.org_id,
      avg(raw.rate)       AS rate,
      max(raw.sampled_at) AS sampled_at
    FROM raw
    GROUP BY raw.inventory_item_id, raw.org_id
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
  'batch. rate is per CAPACITY-night (occupied nights x max_guests), not per '
  'actual headcount — bookings has no guest count. resolvePar() multiplies by '
  'the same max_guests, so the proxy cancels.';

-- Service role only: the recorder runs exclusively inside Inngest, and
-- inventory_consumption_stats has no member-facing write policy by design.
GRANT EXECUTE ON FUNCTION public.record_consumption_samples(jsonb) TO service_role;
