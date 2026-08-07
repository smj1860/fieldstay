-- guidebook_offer_redemptions: one redemption per sponsor, per booking, per day.
--
-- The row is written when a guest opens the redemption pass — the full-screen
-- "Guest Perk · Verified Live" card whose own hint reads "Show this screen to
-- staff — clock proves it's live". It is a coupon presented at the counter, not
-- a page-view, and it is the number a paying sponsor will judge their slot by.
--
-- Opening that pass more than once is the normal case, not an edge case: a
-- guest looks at the offer from the couch, closes it, walks to the business,
-- and opens it again to show staff. Every reopen was a separate row, so raw
-- COUNT(*) overstated real redemptions by however many times the guest looked
-- at their own coupon.
--
-- Nothing reads this table yet. That is exactly why the constraint goes in now:
-- whoever builds the sponsor report later will reach for COUNT(*), and the
-- honest number has to be the one the table can produce.
--
-- Day, not stay: a "free coffee" perk is legitimately redeemable on each day of
-- a booking, so collapsing a whole stay to one row would UNDER-count. Within a
-- day, one redemption per sponsor.
--
-- The day boundary is UTC because the row carries no timezone of its own. For a
-- US property this splits a single evening's repeat opens across two dates only
-- when they straddle UTC midnight (6-8pm local). That errs toward counting one
-- extra, never toward missing a genuinely distinct day — the safe direction for
-- a constraint whose failure mode would otherwise be silently discarding a real
-- redemption.
--
-- Anonymous redemptions (booking_id IS NULL, from the property-level /g/[slug]
-- guidebook, which has no booking token) are deliberately NOT covered: with no
-- guest identity there is nothing to dedupe on, and collapsing them by
-- (sponsor, day) would merge DIFFERENT guests into one. They stay uncapped and
-- unattributed, which is what they are.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_guidebook_offer_redemptions_sponsor_booking_day
  ON guidebook_offer_redemptions (
    sponsor_id,
    booking_id,
    ((opened_at AT TIME ZONE 'UTC')::date)
  )
  WHERE booking_id IS NOT NULL;

COMMENT ON INDEX uniq_guidebook_offer_redemptions_sponsor_booking_day IS
  'One redemption per sponsor per booking per UTC day. Repeat opens of the same pass are the same redemption; app/api/guidebook/redeem relies on this for ignoreDuplicates.';
