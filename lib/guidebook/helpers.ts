import { createServiceClient } from '@/lib/supabase/server'

/**
 * Returns the count of active sponsors for an org.
 * Service client only — called from Inngest and Server Actions.
 */
export async function getActiveSponsorCount(orgId: string): Promise<number> {
  const supabase = createServiceClient()
  const { count, error } = await supabase
    .from('guidebook_sponsors')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'active')

  if (error) throw new Error(`Failed to count active sponsors: ${error.message}`)
  return count ?? 0
}

/**
 * Resolves the plan credit amount in cents based on active sponsor count.
 * Guidebook is always free — this only concerns the bonus plan credits.
 *
 * < 5 sponsors  → no credit
 * 5 sponsors    → $10 credit
 * 6 sponsors    → $25 credit
 */
export function resolvePlanCredit(activeSponsorCount: number): number {
  if (activeSponsorCount >= 6) return 2500
  if (activeSponsorCount >= 5) return 1000
  return 0
}
