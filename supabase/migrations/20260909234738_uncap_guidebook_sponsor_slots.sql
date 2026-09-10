-- ============================================================================
-- Remove the 6-sponsor ceiling from guidebook_sponsors.
--
-- 20260627043346_guidebook_foundation.sql declared:
--     slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 6)
-- alongside UNIQUE(org_id, slot_number).
--
-- The ceiling existed to keep the guest-facing list curated AND to bound the
-- plan credit: at $5 per active sponsor, 6 sponsors capped the credit at
-- $30/month, comfortably under the cheapest possible subscription ($49). That
-- bound is what let resolvePlanCredit() stay a pure multiplication with no
-- knowledge of what the org actually pays.
--
-- The product decision is now that sponsors are UNBOUNDED, and the credit is
-- limited only by the cost of the plan the org is on. So:
--
--   * The CHECK goes. UNIQUE(org_id, slot_number) STAYS — slot numbers are
--     still the per-org identity a media-kit link is minted against, and two
--     sponsors sharing slot 3 would collide there.
--   * The credit gains a real cap in code, computed per org from its own
--     subscription rather than from a constant. resolvePlanCredit()'s
--     docstring already named this as mandatory the moment this constraint
--     was lifted — see lib/guidebook/helpers.ts, and the handler that now
--     passes the cap in.
--
-- GUEST-FACING CURATION IS UNAFFECTED, and that is deliberate rather than an
-- oversight: how many sponsors an org may SELL is now unbounded, but how many
-- any single property SHOWS a guest is still MAX_SPONSORS_PER_PROPERTY (4,
-- lib/guidebook/assignment-constants.ts). A 40-property manager can sell 40
-- sponsorships without any guest seeing an ad wall, because per-property
-- assignment picks a handful for each. The two limits were conflated by the
-- single CHECK and are now separate, which is what makes uncapping safe.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS, per this repo's DDL convention.
-- ============================================================================

ALTER TABLE public.guidebook_sponsors
  DROP CONSTRAINT IF EXISTS guidebook_sponsors_slot_number_check;

-- The lower bound is still real — slot 0 and negatives are meaningless, and
-- dropping the CHECK entirely would have permitted them. Only the UPPER bound
-- was the product decision; this re-states the half that was never in question.
ALTER TABLE public.guidebook_sponsors
  ADD CONSTRAINT guidebook_sponsors_slot_number_check
  CHECK (slot_number >= 1);
