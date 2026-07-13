import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

const MIN_ON_TIME_SAMPLE = 3

interface VendorWorkOrderRow {
  vendor_rating:  number | null
  scheduled_date: string | null
  completed_date: string | null
  status:         string
}

function computeVendorScores(workOrders: VendorWorkOrderRow[]): {
  avgRating:        number | null
  ratingCount:      number
  onTimePct:        number | null
  onTimeSampleSize: number
} {
  const ratings = workOrders
    .map((wo) => wo.vendor_rating)
    .filter((r): r is number => r !== null && r > 0)

  const completedWithDates = workOrders.filter(
    (wo) => wo.status === 'completed' && wo.scheduled_date && wo.completed_date
  )
  const onTimeCount = completedWithDates.filter(
    (wo) => wo.completed_date! <= wo.scheduled_date!
  ).length

  return {
    avgRating:   ratings.length > 0
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
      : null,
    ratingCount: ratings.length,
    onTimePct:   completedWithDates.length >= MIN_ON_TIME_SAMPLE
      ? Math.round((onTimeCount / completedWithDates.length) * 100)
      : null,
    onTimeSampleSize: completedWithDates.length,
  }
}

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
      const supabase = createServiceClient()

      const { data: vendors } = await supabase
        .from('vendors')
        .select('id, work_orders(vendor_rating, scheduled_date, completed_date, status)')

      let count = 0
      for (const v of vendors ?? []) {
        const workOrders = (v.work_orders ?? []) as VendorWorkOrderRow[]
        if (!workOrders.length) continue

        const scores = computeVendorScores(workOrders)
        await supabase
          .from('vendors')
          .update({
            avg_rating:          scores.avgRating,
            rating_count:        scores.ratingCount,
            on_time_pct:         scores.onTimePct,
            on_time_sample_size: scores.onTimeSampleSize,
          })
          .eq('id', v.id)
        count++
      }
      return count
    })

    logger.info(`Vendor score recompute: ${updated} vendors updated`)
    return { updated }
  }
)
