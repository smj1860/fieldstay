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

    if (!candidates.length) return { checked: 0, downgraded: 0 }

    // ONE batched bookings query covering every candidate property's window,
    // instead of one query (and one Inngest step) per turnover — the same
    // "N round trips → 1" fix maintenance-schedules.ts's vacancy-gap pass
    // uses. Step count no longer scales with turnover backlog.
    const idsToDowngrade = await step.run('find-turnovers-without-upcoming-booking', async () => {
      const supabase = createServiceClient()

      const dateOnly = (iso: string) => iso.split('T')[0]!
      const windows = candidates.map((t) => {
        const checkout = new Date(t.checkout_datetime)
        const windowEnd = new Date(checkout.getTime() + NO_BOOKING_WINDOW_DAYS * 86_400_000)
        return {
          id:          t.id,
          property_id: t.property_id,
          fromDate:    dateOnly(checkout.toISOString()),
          toDate:      dateOnly(windowEnd.toISOString()),
        }
      })

      const uniquePropertyIds = [...new Set(windows.map((w) => w.property_id))]
      const minFrom = windows.reduce((min, w) => (w.fromDate < min ? w.fromDate : min), windows[0]!.fromDate)
      const maxTo   = windows.reduce((max, w) => (w.toDate   > max ? w.toDate   : max), windows[0]!.toDate)

      const { data: bookings } = await supabase
        .from('bookings')
        .select('property_id, checkin_date')
        .in('property_id', uniquePropertyIds)
        .in('status', ['confirmed', 'tentative'])
        .gte('checkin_date', minFrom)
        .lte('checkin_date', maxTo)

      const checkinsByProperty = new Map<string, string[]>()
      for (const b of bookings ?? []) {
        const list = checkinsByProperty.get(b.property_id) ?? []
        list.push(b.checkin_date)
        checkinsByProperty.set(b.property_id, list)
      }

      return windows
        .filter((w) => {
          const checkins = checkinsByProperty.get(w.property_id) ?? []
          return !checkins.some((d) => d >= w.fromDate && d <= w.toDate)
        })
        .map((w) => w.id)
    })

    if (idsToDowngrade.length) {
      await step.run('downgrade-turnovers', async () => {
        const supabase = createServiceClient()
        await supabase
          .from('turnovers')
          .update({ priority: 'low' })
          .in('id', idsToDowngrade)
          .eq('priority', 'medium')  // optimistic lock — don't clobber a manual override made between the check and this write
      })
    }

    return { checked: candidates.length, downgraded: idsToDowngrade.length }
  }
)
