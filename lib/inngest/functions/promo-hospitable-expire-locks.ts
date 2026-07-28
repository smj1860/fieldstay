import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * SCHEDULED: runs daily. Deactivates any Hospitable launch promo price lock
 * whose price_lock_expires_at has passed — the lock itself (1 or 2 years from
 * award), not the separate tier-2 90-day award-eligibility window, which is
 * enforced at award time by claim_hospitable_promo_slot() instead.
 */
export const expireHospitablePriceLocks = inngest.createFunction(
  {
    id:      'promo-hospitable-expire-price-locks',
    name:    'Hospitable Promo: Expire Price Locks',
    retries: 1,
  },
  { cron: '0 9 * * *' },
  async ({ step, logger }) => {
    const expired = await step.run('expire-due-locks', async () => {
      const supabase = createServiceClient({ system: 'inngest:promo-hospitable-expire-price-locks' })
      const { data, error } = await supabase
        .from('hospitable_launch_promo')
        .update({ price_lock_active: false })
        .eq('price_lock_active', true)
        .lt('price_lock_expires_at', new Date().toISOString())
        .select('org_id, price_lock_sequence')

      if (error) {
        // PGRST205: PostgREST can't find the table in its schema cache — the
        // hospitable_launch_promo migration is deliberately held back until
        // an explicit launch go-ahead (applying it starts the 90-day tier-2
        // clock, a business decision). This cron is registered and running
        // regardless, so until that migration ships, "table not found" is
        // the expected state, not a failure — log-level info, not an error,
        // so it doesn't burn Inngest retries or page anyone for a feature
        // that isn't live yet. Confirmed empirically against the live
        // project (not guessed): a query against the not-yet-migrated table
        // returns exactly this code.
        if (error.code === 'PGRST205') {
          logger.info('[Hospitable promo] hospitable_launch_promo not yet migrated — skipping, not an error')
          return null
        }
        throw new Error(`Failed to expire due Hospitable price locks: ${error.message}`)
      }

      return data ?? []
    })

    if (expired === null) {
      return { skipped: true, reason: 'not_yet_migrated' }
    }

    if (expired.length > 0) {
      logger.info(
        `Hospitable price locks expired for ${expired.length} org(s): ` +
        expired.map((e) => `org=${e.org_id} seq=${e.price_lock_sequence ?? 'n/a'}`).join(', ')
      )
    }

    return { expiredCount: expired.length }
  }
)
