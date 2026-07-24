import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * SCHEDULED: runs nightly.
 *
 * vendors.avg_rating/rating_count are real, long-standing columns that no
 * code ever wrote to — the maintenance-schedule vendor-specialty fallback
 * (cron/work-order-ops.ts) sorts candidates by avg_rating, but it's been
 * frozen at its row-creation default the whole time. The vendors list page
 * (app/(dashboard)/vendors/page.tsx) works around this by recomputing the
 * real average from work_orders.vendor_rating on every page load instead of
 * trusting the stored column. This cron closes that gap the same way the
 * crew-score-recompute cron closed it for crew_members: it applies the exact
 * same math server-side, on a schedule, and actually persists it — so both
 * the static fallback and the new vendor-suggestion engine
 * (auto-assign-vendor.ts) can read a properly-maintained value directly.
 *
 * on_time_pct/on_time_sample_size were declared on the TypeScript Vendor
 * interface but were never real columns at all until the migration that
 * shipped alongside this cron — pure schema/type drift, now fixed.
 */
export const vendorScoreRecompute = inngest.createFunction(
  { id: 'cron-vendor-score-recompute', name: 'Cron: Recompute Vendor Rating & On-Time Scores', retries: 2 },
  { cron: '15 9 * * *' }, // ~3-4am CT, shortly after the crew score recompute
  async ({ step, logger }) => {
    const updated = await step.run('recompute-vendor-scores', async () => {
      const supabase = createServiceClient({ system: 'inngest:vendor-score-recompute' })
      const { data, error } = await supabase.rpc('recompute_vendor_scores')
      if (error) throw new Error(`recompute_vendor_scores failed: ${error.message}`)
      return data as number
    })

    logger.info(`Vendor score recompute: ${updated} vendors updated`)
    return { updated }
  }
)
