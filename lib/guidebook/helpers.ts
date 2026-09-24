import { createServiceClient } from '@/lib/supabase/server'
import { CREDIT_PER_SPONSOR_CENTS } from './sponsor-economics'

/**
 * Returns the count of active sponsors for an org.
 * Service client only — called from Inngest and Server Actions.
 */
export async function getActiveSponsorCount(orgId: string): Promise<number> {
  const supabase = createServiceClient({ system: 'lib/guidebook/helpers' })
  const { count, error } = await supabase
    .from('guidebook_sponsors')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'active')

  if (error) throw new Error(`Failed to count active sponsors: ${error.message}`)
  return count ?? 0
}

/**
 * Dollars (in cents) of plan credit earned per active sponsor, per month.
 *
 * Re-exported from lib/guidebook/sponsor-economics.ts, a leaf module with no
 * imports, so a marketing page or client component can read the figure without
 * importing THIS file and dragging createServiceClient() along with it. The
 * name and value are unchanged; existing importers of this module are
 * unaffected.
 */
export { CREDIT_PER_SPONSOR_CENTS } from './sponsor-economics'

/**
 * Resolves the plan credit amount in cents.
 *
 * Flat $5/sponsor/month, from the first one. Sponsors pay $15/mo, so this is a
 * 33% share.
 *
 * REPLACED a two-step threshold (5 → $10, 6 → $25) whose shape was the
 * problem: a host who signed a fourth sponsor earned nothing for it, and a
 * host at six had no reason to care about the program again. It also paid
 * nothing at THREE sponsors — the count that unlocks the guidebook and the
 * single most important activation milestone in the product. That now pays
 * $15. No customer's credit goes down at any count.
 *
 * Guidebook ACCESS is a separate, non-monetary threshold (3 sponsors) and is
 * NOT resolved here — this function only concerns the plan credit.
 *
 * ── planCostCents: the cap, now that the sponsor count has none ────────────
 *
 * The sponsor count USED to be bounded at 6 by
 * guidebook_sponsors_slot_number_check, so this returned at most $30 —
 * comfortably below the cheapest plan at the time ($49, the pre-2026-09-24
 * anchor) — and needed no cap. The previous
 * version of this docstring said, in as many words, that if that ceiling were
 * ever lifted this function would gain no upper bound, could exceed an
 * invoice, and that a cap "becomes mandatory then".
 *
 * 20260909234738_uncap_guidebook_sponsor_slots.sql lifted it. This parameter
 * is that cap, and it is REQUIRED rather than optional precisely so the
 * mandatory thing cannot be forgotten at a call site: an org with 40 sponsors
 * earns $200 of a $68 plan and is credited $68, not $200.
 *
 * Why a cap rather than letting it run negative: Stripe carries credit above
 * the invoice subtotal as customer balance, forward, indefinitely — so an
 * uncapped credit does not merely zero a bill, it accrues a liability that
 * quietly discounts every future invoice as well. Capping means the bill
 * floors at zero and the marginal sponsor past that point earns nothing,
 * which is the intended commercial shape: the program pays for the software,
 * it does not pay the customer.
 *
 * The caller derives planCostCents from the subscription's own quantity via
 * lib/stripe/brackets.ts — NOT by summing invoice lines, which would have to
 * exclude `invoiceitem` lines or double-count a credit already posted this
 * period. See guidebook-billing-credit-handler.ts.
 *
 * ⚠️ OPEN DECISION — ANNUAL SUBSCRIBERS. The credit is posted once per
 * RENEWAL (guidebook-daily-monitor dispatches inside a 48-hour renewal
 * window), so a monthly org earns this 12 times a year and an annual org
 * earns it ONCE — one month's worth against a twelve-month invoice. That
 * asymmetry predates this change and was nearly invisible while the credit
 * was capped at $30; uncapping makes it the difference between $2,400/yr and
 * $200/yr for the same 40 sponsors. Deliberately NOT changed here, because
 * paying annual orgs the 12 months they accrued is a real money decision
 * rather than a refactor. Behaviour for annual is exactly what it was.
 */
export function resolvePlanCredit(activeSponsorCount: number, planCostCents: number): number {
  if (activeSponsorCount <= 0) return 0

  const earned = activeSponsorCount * CREDIT_PER_SPONSOR_CENTS

  // A negative or NaN plan cost means the caller could not resolve the
  // subscription. Credit nothing rather than guessing — an over-credit is
  // real money out, and a skipped cycle is recoverable.
  if (!Number.isFinite(planCostCents) || planCostCents <= 0) return 0

  return Math.min(earned, planCostCents)
}
