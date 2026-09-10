// ============================================================================
// lib/guidebook/sponsor-economics.ts
//
// The sponsor program's money figures, in one leaf module with NO imports.
//
// Split out of lib/guidebook/helpers.ts for the same reason
// lib/guidebook/assignment-constants.ts was split out of
// resolve-property-sponsors.ts: helpers.ts calls createServiceClient(), so
// anything importing it drags a server-only Supabase client along. A marketing
// page or a 'use client' component that only wants to read a number should not
// have to. That failure mode breaks the BUILD, not the typecheck — tsc has
// nothing to say about server-only, so it looks fine right up until
// `next build`.
//
// These numbers are quoted verbatim on public marketing pages, which is the
// real reason they are worth centralising: a price a stranger reads and an
// invoice they later receive have to agree.
// ============================================================================

/**
 * Dollars (in cents) of plan credit earned per active sponsor, per month.
 *
 * Flat, from the first sponsor. lib/guidebook/helpers.ts re-exports this and
 * resolvePlanCredit() multiplies by it; unit/lib/guidebook-plan-credit.test.ts
 * pins the resulting schedule.
 */
export const CREDIT_PER_SPONSOR_CENTS = 500

/**
 * What a sponsor pays per month.
 *
 * ⚠️ NOT ENFORCED HERE. The authoritative amount is the Stripe Price behind
 * STRIPE_PRICE_SPONSOR_MONTHLY, set in the Stripe dashboard — this constant is
 * a MIRROR of it, kept so marketing copy has one place to read rather than
 * five string literals (it was retyped in lib/faq-content.ts,
 * app/hosts/page.tsx, components/landing/homepage-content.tsx and a comment in
 * helpers.ts before this module existed).
 *
 * If the Stripe Price changes, change this in the same sitting — nothing will
 * fail if you don't, which is exactly why it is called out.
 */
export const SPONSOR_PRICE_CENTS = 1500

/**
 * ⚠️ THERE IS NO LONGER A SPONSOR CEILING — deliberately no constant here.
 *
 * `guidebook_sponsors` used to carry `CHECK (slot_number BETWEEN 1 AND 6)`,
 * dropped by 20260909234738_uncap_guidebook_sponsor_slots.sql. An org may now
 * sell as many sponsorships as it can find local businesses for.
 *
 * The old ceiling was doing TWO jobs at once, and separating them is what made
 * removing it safe:
 *
 *   1. Bounding the plan credit. At $5 per sponsor, 6 sponsors capped the
 *      credit at $30 — under the cheapest possible subscription ($49), which
 *      is what let resolvePlanCredit() stay a pure multiplication with no
 *      knowledge of what the org pays. That job now belongs to the per-org cap
 *      resolvePlanCredit() takes as an argument: the credit cannot exceed the
 *      cost of the plan the org is actually on.
 *   2. Keeping the guest-facing list curated. That job is UNCHANGED, and was
 *      never really this constant's — MAX_SPONSORS_PER_PROPERTY (4, in
 *      ./assignment-constants.ts) is what bounds how many sponsors a single
 *      property SHOWS a guest. Selling 40 sponsorships across 40 properties
 *      puts no more in front of any one guest than selling 4 did.
 *
 * Do not reintroduce an org-level ceiling constant here. If a limit is ever
 * wanted again it belongs in the database as a real constraint, the way the
 * old one was, rather than as a number application code hopes everyone reads.
 */

/**
 * Active sponsors required to unlock the guidebook permanently.
 *
 * A separate, NON-MONETARY milestone from the credit — the guidebook is
 * otherwise free only during the trial. Do not conflate the two: an earlier
 * credit schedule paid nothing at this exact count, which was the flaw that
 * got it replaced.
 */
export const SPONSORS_TO_UNLOCK_GUIDEBOOK = 3

/**
 * How many active sponsors it takes to cover a plan of `planCostCents`
 * entirely — the point at which the credit hits its cap and the org's
 * FieldStay bill reaches zero.
 *
 * Exists so nothing has to hand-derive it. It is the number the guidebook UI
 * shows as a target, and the one the marketing pages describe in words; both
 * were the sort of figure that gets typed once, rounded wrong, and then
 * contradicted by the invoice.
 *
 * Rounds UP: at $5 a sponsor, a $49 plan needs 10 sponsors, not 9.8. The
 * final sponsor earns less than the full $5 because the cap clips it, which
 * is the intended shape — the program pays for the software, it does not pay
 * the customer.
 */
export function sponsorsToCoverPlan(planCostCents: number): number {
  if (!Number.isFinite(planCostCents) || planCostCents <= 0) return 0
  return Math.ceil(planCostCents / CREDIT_PER_SPONSOR_CENTS)
}
