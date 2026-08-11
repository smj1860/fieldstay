-- PAR pass 2, learning side: fold new consumption observations into the
-- rolling average inventory_consumption_stats holds.
--
-- The update is an incremental mean:
--     new_avg = (old_avg * old_n + rate) / (old_n + 1)
--     new_n   = old_n + 1
-- computed INSIDE the ON CONFLICT DO UPDATE so it is atomic. Doing it in
-- application code would be a read-modify-write, and two counts submitted for
-- the same property at once (a crew member and a PM, or an Inngest retry
-- overlapping the original) would each read the same old_n and one sample
-- would vanish.
--
-- A NOTE ON THE UNIT, because the column name is easy to misread.
-- avg_rate_per_guest_night is per CAPACITY-night, not per actual-headcount
-- night: bookings carries no guest-count column anywhere in this schema, so
-- real occupancy is not observable. The recorder divides by
-- occupied_nights * properties.max_guests, and resolvePar()'s historical
-- branch multiplies back by the same max_guests — so the proxy cancels and the
-- round trip stays self-consistent. Anyone who later divides this by a REAL
-- headcount will get numbers that are wrong by the ratio of occupancy to
-- capacity. If bookings ever gains a guest count, change BOTH sides together.
--
-- last_sample_at takes the newer of the two, so a replayed older count cannot
-- drag it backwards.

CREATE OR REPLACE FUNCTION public.record_consumption_samples(p_rows jsonb)
RETURNS integer
LANGUAGE sql
AS $$
  WITH v AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
      AS x(inventory_item_id uuid, org_id uuid, rate numeric, sampled_at timestamptz)
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
  'lose a sample. rate is per CAPACITY-night (occupied nights x max_guests), '
  'not per actual headcount — bookings has no guest count. resolvePar() '
  'multiplies by the same max_guests, so the proxy cancels.';

-- Service role only: the recorder runs exclusively inside Inngest, and
-- inventory_consumption_stats has no member-facing write policy by design.
GRANT EXECUTE ON FUNCTION public.record_consumption_samples(jsonb) TO service_role;
