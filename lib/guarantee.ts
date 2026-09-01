/**
 * lib/guarantee.ts
 *
 * Single source of truth for The FieldStay Record Guarantee's terms —
 * modeled on lib/stripe/brackets.ts: one module, zero dependencies, safe to
 * import from a 'use client' component. Every surface that states a
 * guarantee number imports from here; unit/guardrails/guarantee-numbers.test.ts
 * is the structural backstop.
 *
 * This replaces the old "Glass Box Operations Guarantee" — a transparency
 * promise with no monetary remedy — with a real, credit-bearing commitment:
 * if a customer asks what happened on a job and FieldStay cannot produce the
 * record, that month is credited. It depends on
 * RECORD_GUARANTEE_IMPLEMENTATION.md's Workstream 1 (crew_sync_incidents)
 * existing, which is why that workstream is a blocking prerequisite —
 * without it, a device dead-lettering silently would make the guarantee
 * un-adjudicable.
 *
 * The pricing rebuild's lib/stripe/brackets.ts carries a comment about a
 * draft that said 30 days while the live site said 14 — publishing that
 * mismatch would have been a live inconsistency the citation discipline
 * exists to catch. Here a drift is not an inconsistency, it's a conflicting
 * legal representation, so this module is the ONLY place any of these
 * numbers may be typed as a literal.
 */

export const GUARANTEE_NAME = 'The FieldStay Record Guarantee'
export const GUARANTEE_SCOPE_LINE =
  'We guarantee the record of what happened — not the work itself.'

/** Business days FieldStay commits to respond to a claim within. */
export const RESPONSE_WINDOW_BUSINESS_DAYS = 2
/** How far back a claim may reach — the guarantee does not cover the whole account history. */
export const COVERED_PERIOD_MONTHS = 24
/** Days from the missing-record event a customer has to file a claim. */
export const CLAIM_WINDOW_DAYS = 30
/** Maximum credits in one billing period, however many genuine gaps are found in it. */
export const CREDITS_PER_BILLING_PERIOD = 1
/** Notice FieldStay commits to before narrowing or ending the guarantee. */
export const CHANGE_NOTICE_DAYS = 30
export const GUARANTEE_EMAIL = 'guarantee@fieldstay.com'
