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
        throw new Error(`Failed to expire due Hospitable price locks: ${error.message}`)
      }

      return data ?? []
    })

    if (expired.length > 0) {
      logger.info(
        `Hospitable price locks expired for ${expired.length} org(s): ` +
        expired.map((e) => `org=${e.org_id} seq=${e.price_lock_sequence ?? 'n/a'}`).join(', ')
      )
    }

    return { expiredCount: expired.length }
  }
)
