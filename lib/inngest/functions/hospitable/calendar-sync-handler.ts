// lib/inngest/functions/hospitable/calendar-sync-handler.ts
// ============================================================
// Triggered by: integration/hospitable.calendar_sync.requested
// Fired by:     hospCalendarSyncCron, once daily per active Hospitable
//               property.
//
// Fetches a forward-looking window of GET /properties/{uuid}/calendar,
// consolidates consecutive manually-blocked days into ranges (see
// consolidateHospitableBlocks's doc comment for the exact status.reason/
// source_type signal), and upserts a synthetic `bookings` row per range
// (is_block: true, status: 'blocked') keyed by a stable external_id — a
// PM lifting a block later just means that range's external_id doesn't
// reappear in a future run, which is reconciled below.
//
// No turnover regeneration call here, unlike the reservation/iCal sync
// handlers: generateTurnoversForProperty already excludes is_block rows
// entirely from its query, so a block's presence or absence never changes
// what it would produce.
// ============================================================

import { inngest }                 from '@/lib/inngest/client'
import { createServiceClient }     from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { hospFetchCalendar, consolidateHospitableBlocks } from '@/lib/integrations/providers/hospitable'
import type { BookingSource } from '@/types/database'

const PROVIDER            = 'hospitable'
const CALENDAR_WINDOW_DAYS = 90

export const hospCalendarSyncHandler = inngest.createFunction(
  {
    id:      'hospitable-calendar-sync-handler',
    name:    'Hospitable: Calendar Block Sync Handler',
    retries: 2,
    concurrency: { limit: 2, key: 'event.data.org_id' },
  },
  { event: 'integration/hospitable.calendar_sync.requested' as const },
  async ({ event, step, logger }) => {
    const { property_id, org_id, user_id, hospitable_property_id } = event.data

    const token = await step.run('get-valid-token', async () => {
      return getValidHospitableToken(user_id)
    })

    const { startDate, endDate } = await step.run('compute-window', async () => {
      const start = new Date()
      const end   = new Date(start.getTime() + CALENDAR_WINDOW_DAYS * 86_400_000)
      return {
        startDate: start.toISOString().split('T')[0]!,
        endDate:   end.toISOString().split('T')[0]!,
      }
    })

    const days = await step.run('fetch-calendar', async () => {
      return hospFetchCalendar(token, hospitable_property_id, startDate, endDate)
    })

    const result = await step.run('reconcile-blocks', async () => {
      const supabase = createServiceClient()
      const ranges    = consolidateHospitableBlocks(days)

      const rows = ranges.map((r) => ({
        org_id,
        property_id,
        external_source: PROVIDER,
        external_id:     `hospitable-block:${hospitable_property_id}:${r.checkin_date}`,
        checkin_date:    r.checkin_date,
        checkout_date:   r.checkout_date,
        checkin_time:    null,
        checkout_time:   null,
        status:          'blocked' as const,
        guest_name:      null,
        guest_email:     null,
        source:          'other' as BookingSource,
        is_block:        true,
        stay_type:       'guest_stay' as const,
        actual_total_amount: null,
      }))

      if (rows.length > 0) {
        const { error } = await supabase
          .from('bookings')
          .upsert(rows, { onConflict: 'external_id,external_source' })

        if (error) throw new Error(`Block upsert failed: ${error.message}`)
      }

      // Reconcile: any previously-synced block for this property that
      // overlaps the window we just fetched but isn't in the current set
      // means the PM lifted it — cancel it rather than leaving a stale
      // "Blocked" row on the calendar forever.
      const currentExternalIds = new Set(rows.map((r) => r.external_id))

      const { data: existingBlocks, error: fetchErr } = await supabase
        .from('bookings')
        .select('id, external_id')
        .eq('property_id', property_id)
        .eq('external_source', PROVIDER)
        .eq('is_block', true)
        .neq('status', 'cancelled')
        .lte('checkin_date', endDate)
        .gte('checkout_date', startDate)

      if (fetchErr) throw new Error(`Fetching existing blocks failed: ${fetchErr.message}`)

      const toCancel = (existingBlocks ?? []).filter(
        (b) => !currentExternalIds.has(b.external_id)
      )

      if (toCancel.length > 0) {
        const { error: cancelErr } = await supabase
          .from('bookings')
          .update({ status: 'cancelled' })
          .in('id', toCancel.map((b) => b.id))

        if (cancelErr) throw new Error(`Cancelling stale blocks failed: ${cancelErr.message}`)
      }

      return { activeCount: rows.length, cancelledCount: toCancel.length }
    })

    logger.info(
      `[Hospitable calendar-sync] property ${property_id}: ${result.activeCount} active block(s), ${result.cancelledCount} lifted`
    )

    return result
  }
)
