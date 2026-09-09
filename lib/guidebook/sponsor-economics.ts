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
 * The hard ceiling on active sponsors per organization.
 *
 * Enforced in the DATABASE, not by application policy: guidebook_sponsors has
 * `slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 6)` plus
 * `UNIQUE(org_id, slot_number)` (20260627043346_guidebook_foundation.sql), so
 * a seventh row cannot be written whatever the calling code believes.
 *
 * resolvePlanCredit()'s upper-bound reasoning depends on this — see its
 * docstring for what stops being true if the ceiling is ever lifted.
 */
export const MAX_SPONSORS_PER_ORG = 6

/** The most any org can take off its bill through the sponsor program. */
export const MAX_SPONSOR_CREDIT_CENTS = CREDIT_PER_SPONSOR_CENTS * MAX_SPONSORS_PER_ORG

/**
 * Active sponsors required to unlock the guidebook permanently.
 *
 * A separate, NON-MONETARY milestone from the credit — the guidebook is
 * otherwise free only during the trial. Do not conflate the two: an earlier
 * credit schedule paid nothing at this exact count, which was the flaw that
 * got it replaced.
 */
export const SPONSORS_TO_UNLOCK_GUIDEBOOK = 3
