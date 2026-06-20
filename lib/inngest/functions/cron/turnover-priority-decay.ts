import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

const NO_BOOKING_WINDOW_DAYS = 14

/**
 * SCHEDULED: runs daily.
 *
 * Standalone turnovers (no next booking known at creation time) default to
 * 'medium' priority since urgency is unknown. This pass re-checks each one
 * daily: if there's still no booking within NO_BOOKING_WINDOW_DAYS of the
 * checkout, there's no real time pressure — downgrade to 'low' so crew
 * capacity prioritization correctly favors turnovers with actual deadlines.
 *
 * Upgrades back to a higher tier are NOT handled here — once a real next
 * booking appears, the turnover generator's Pass 2 recomputes priority
 * from the actual gap the next time it runs for that property.
 */
export const turnoverPriorityDecay = inngest.createFunction(
  {
    id:      'cron-turnover-priority-decay',
    name:    'Cron: Downgrade Unbooked Standalone Turnover Priority',
    retries: 2,
  },
  { cron: '0 14 * * *' },  // 9am CT (UTC-5), after the maintenance cron's 8am run
  async ({ step, logger }) => {
    const candidates = await step.run('find-standalone-medium-turnovers', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('turnovers')
        .select('id, property_id, checkout_datetime')
        .is('prev_booking_id', null)
        .eq('priority', 'medium')
        .not('status', 'in', '("completed","cancelled")')

      return data ?? []
    })

    logger.info(`Checking ${candidates.length} standalone turnovers for priority decay`)

    let downgraded = 0

    for (const turnover of candidates) {
      const shouldDowngrade = await step.run(`check-${turnover.id}`, async () => {
        const supabase = createServiceClient()
        const checkoutDate = new Date(turnover.checkout_datetime)
        const windowEnd = new Date(checkoutDate.getTime() + NO_BOOKING_WINDOW_DAYS * 86_400_000)

        const { data: upcomingBooking } = await supabase
          .from('bookings')
          .select('id')
          .eq('property_id', turnover.property_id)
          .in('status', ['confirmed', 'tentative'])
          .gte('checkin_date', checkoutDate.toISOString().split('T')[0])
          .lte('checkin_date', windowEnd.toISOString().split('T')[0])
          .limit(1)
          .maybeSingle()

        return !upcomingBooking
      })

      if (shouldDowngrade) {
        await step.run(`downgrade-${turnover.id}`, async () => {
          const supabase = createServiceClient()
          await supabase
            .from('turnovers')
            .update({ priority: 'low' })
            .eq('id', turnover.id)
            .eq('priority', 'medium')  // optimistic lock — don't clobber a manual override made between the check and this write
        })
        downgraded++
      }
    }

    return { checked: candidates.length, downgraded }
  }
)
