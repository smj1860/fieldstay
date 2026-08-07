-- guidebook_offer_redemptions.open_count — engagement, alongside the deduped
-- redemption it lives on.
--
-- 20260807150000 made the row unique per (sponsor, booking, UTC day) so a paying
-- sponsor's redemption count stops being inflated by a guest reopening their own
-- coupon. Correct for that number, but it threw away a real second signal: how
-- many times the pass was actually opened. "12 redemptions, opened 31 times"
-- says something "12 redemptions" alone does not.
--
-- One column on the existing row rather than a second table: the dedup key IS
-- the natural grain for the counter, so the count stays bounded by the same
-- constraint instead of growing per tap, and both numbers come out of one
-- query — COUNT(*) for redemptions, SUM(open_count) for opens.
--
-- Anonymous redemptions (booking_id NULL, property-level /g/[slug]) sit outside
-- the partial unique index, so each open is its own row at open_count = 1. Both
-- aggregates still read correctly there; they simply carry no more information
-- than each other, which is the honest answer when there is no guest identity
-- to attribute opens to.

ALTER TABLE guidebook_offer_redemptions
  ADD COLUMN IF NOT EXISTS open_count integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN guidebook_offer_redemptions.open_count IS
  'Times the redemption pass was opened for this (sponsor, booking, UTC day). COUNT(*) = redemptions; SUM(open_count) = opens.';

-- The insert-or-increment, as one statement.
--
-- It has to be a function: the arbiter is a PARTIAL EXPRESSION index, and
-- PostgREST's on_conflict parameter only accepts plain column names, so the
-- JS client cannot express this upsert at all. Doing it as read-then-write in
-- the route would be a TOCTOU — two taps racing would both read 1 and both
-- write 2.
--
-- SECURITY INVOKER (the default), deliberately. The only caller is the redeem
-- route holding the service role, which already bypasses RLS; a DEFINER
-- function here would add an privilege-escalation surface that buys nothing.
CREATE OR REPLACE FUNCTION public.record_guidebook_offer_open(
  p_org_id     uuid,
  p_sponsor_id uuid,
  -- DEFAULT NULL so the anonymous case (property-level /g/[slug], no booking
  -- token) can omit the argument entirely. Without a default, Supabase's type
  -- generator emits `p_booking_id: string` — required and non-nullable — and
  -- the only ways to call it with a null are a cast or a second write path.
  p_booking_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO guidebook_offer_redemptions (org_id, sponsor_id, booking_id)
  VALUES (p_org_id, p_sponsor_id, p_booking_id)
  ON CONFLICT (sponsor_id, booking_id, ((opened_at AT TIME ZONE 'UTC')::date))
    WHERE booking_id IS NOT NULL
  DO UPDATE SET open_count = guidebook_offer_redemptions.open_count + 1;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default, which on a
-- Supabase project means anon can call it over /rest/v1/rpc/ with the
-- publishable key — i.e. write rows to a tenant table with no session at all.
-- Every anon TABLE grant was revoked on 2026-07-24; a function is the same
-- exposure through a different door.
REVOKE ALL ON FUNCTION public.record_guidebook_offer_open(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_guidebook_offer_open(uuid, uuid, uuid) TO service_role;
