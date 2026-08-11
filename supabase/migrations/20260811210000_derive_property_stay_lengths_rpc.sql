-- PAR pass 2: derive each property's typical stay length from its own
-- bookings, rather than from properties.avg_stay_length.
--
-- WHY NOT THE COLUMN. properties.avg_stay_length has no editor anywhere in the
-- app -- no form renders it, no Server Action writes it -- and three code
-- paths (lib/properties/upsert-normalized.ts, and the OwnerRez and Hostaway
-- initial syncs) write a literal 0. withPropertyDefaults()'s `?? 3.0` cannot
-- correct that, because `??` only catches NULL and a real 0 is stored. On
-- 2026-08-11 that left 17 of 27 live properties at 0, and -- the tell -- the
-- only rows holding a "real" 3.0 were the four properties with no bookings at
-- all. The stored column was inversely correlated with having any data.
--
-- WHY NOT SYNC IT FROM A CHANNEL. It is not a field any integration supplies;
-- it is an aggregate over rows we already hold. Every booking carries
-- checkin_date and checkout_date regardless of source, so a hand-entered
-- booking feeds this average exactly like an iCal or OwnerRez one. There is no
-- manual-entry gap to close.
--
-- WHY AN RPC RATHER THAN READING bookings INTO THE APP. A whole-org recompute
-- over a 50-property portfolio would pull tens of thousands of booking rows
-- only to reduce each property's to a single number -- and an unbounded
-- PostgREST select truncates at max_rows = 1000 silently, returning a wrong
-- average with a 200 and no signal. Aggregating in SQL returns one row per
-- property, bounded by a property count that is already capped upstream.
--
-- WHAT COUNTS AS A STAY:
--   * confirmed AND tentative. Not just confirmed -- 27 of the 57 live
--     bookings are tentative channel imports carrying an external_id, and two
--     properties have ONLY tentative rows. Counting confirmed alone would give
--     those properties no signal and silently fall back to the default.
--   * is_block = false. An owner hold or maintenance block is not a guest
--     stay; the one live blocked row is 8 nights and would skew a small
--     sample badly. Same filter the consumption recorder already applies.
--   * cancelled excluded -- the stay never happened.
--   * checkout strictly after checkin, so a malformed row cannot contribute a
--     zero or negative night count to the mean.
--
-- The minimum-sample policy deliberately lives in TypeScript
-- (STAY_LENGTH_MIN_BOOKINGS in lib/inventory/par-engine.ts) next to the other
-- par constants, not here. This function stays a dumb aggregate and returns
-- the count alongside the average so the caller can apply it.

CREATE OR REPLACE FUNCTION public.derive_property_stay_lengths(
  p_org_id       uuid,
  p_property_ids uuid[]
)
RETURNS TABLE (property_id uuid, avg_nights numeric, sample_count integer)
LANGUAGE sql
STABLE
AS $$
  SELECT b.property_id,
         avg(b.checkout_date - b.checkin_date)::numeric AS avg_nights,
         count(*)::int                                  AS sample_count
  FROM public.bookings b
  WHERE b.org_id = p_org_id
    AND b.property_id = ANY(p_property_ids)
    AND b.status IN ('confirmed', 'tentative')
    AND b.is_block = false
    AND b.checkout_date > b.checkin_date
  GROUP BY b.property_id;
$$;

COMMENT ON FUNCTION public.derive_property_stay_lengths(uuid, uuid[]) IS
  'Average nights per stay per property, from bookings. Counts confirmed and '
  'tentative non-block stays only. Replaces properties.avg_stay_length in the '
  'par path, which has no editor and is a literal 0 on most live rows. '
  'Returns sample_count so the caller can enforce a minimum before trusting '
  'the average.';

-- SECURITY INVOKER (the default) is deliberate: RLS still applies for any
-- non-service caller, and the explicit org_id filter is the second line.
-- Only the Inngest recompute calls this today, via the service client.
GRANT EXECUTE ON FUNCTION public.derive_property_stay_lengths(uuid, uuid[]) TO authenticated;
