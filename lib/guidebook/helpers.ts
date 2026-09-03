import { createServiceClient } from '@/lib/supabase/server'

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

/** Dollars (in cents) of plan credit earned per active sponsor, per month. */
export const CREDIT_PER_SPONSOR_CENTS = 500

/**
 * Resolves the plan credit amount in cents from the active sponsor count.
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
 * The count is bounded at 6 by guidebook_sponsors_slot_number_check, so this
 * returns at most 3000 — comfortably below the cheapest plan ($4,900). If that
 * ceiling is ever lifted this function gains no upper bound and can exceed an
 * invoice, and the handler has no cap: credit above the subtotal accrues as
 * Stripe customer balance and carries forward indefinitely. A cap computed
 * from subscription lines only (excluding `invoiceitem` lines, or it
 * double-counts a credit already posted this period) becomes mandatory then.
 */
export function resolvePlanCredit(activeSponsorCount: number): number {
  if (activeSponsorCount <= 0) return 0
  return activeSponsorCount * CREDIT_PER_SPONSOR_CENTS
}
