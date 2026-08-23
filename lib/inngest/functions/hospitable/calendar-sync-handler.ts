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
import { createPmNotification }    from '@/lib/inngest/helpers'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { ProviderEntityGoneError } from '@/lib/integrations/types'
import { hospFetchCalendar, consolidateHospitableBlocks } from '@/lib/integrations/providers/hospitable'
import type { BookingSource } from '@/types/database'

const PROVIDER            = 'hospitable'
const CALENDAR_WINDOW_DAYS = 90

export const hospCalendarSyncHandler = inngest.createFunction(
  {
    id:      'hospitable-calendar-sync-handler',
    name:    'Hospitable: Calendar Block Sync Handler',
    retries: 2,
    // Cron-fanned across every active connection — at 100 customers this
    // would otherwise burst 100-wide into the single shared
    // hospitableApiLimiter budget. Platform cap plus the existing per-org
    // limit, same shape as hospInitialSync's.
    concurrency: [
      { limit: 4 },
      { limit: 2, key: 'event.data.org_id' },
    ],
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

    // A 404 is answered by PAUSING this property rather than by retrying. The
    // step returns a DECISION and the pause happens at the function's top
    // level, because step tooling inside a step.run callback re-runs the whole
    // callback on the next pass (CLAUDE.md, enforced by
    // unit/guardrails/inngest-nested-steps.test.ts).
    const fetched = await step.run('fetch-calendar', async () => {
      try {
        return { gone: false as const, days: await hospFetchCalendar(token, hospitable_property_id, startDate, endDate) }
      } catch (err) {
        if (err instanceof ProviderEntityGoneError) return { gone: true as const, days: [] }
        throw err
      }
    })

    if (fetched.gone) {
      await step.run('mark-property-missing', () =>
        markPropertyMissing(org_id, property_id))

      logger.warn(
        `[Hospitable calendar-sync] property ${property_id}: Hospitable no longer recognises ` +
        `its listing — calendar sync paused until the provider lists it again`
      )
      return { activeCount: 0, cancelledCount: 0, paused: true }
    }

    const days = fetched.days

    const result = await step.run('reconcile-blocks', async () => {
      const supabase = createServiceClient({ system: 'inngest:calendar-sync-handler' })
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
          .upsert(rows, { onConflict: 'org_id,external_id,external_source' })

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
        // One property's blocks inside one sync window — a truncated read here
        // only leaves a stale Blocked row that the next run clears, but the
        // bound keeps the intent explicit rather than relying on that.
        .limit(1000)

      if (fetchErr) throw new Error(`Fetching existing blocks failed: ${fetchErr.message}`)

      // bookings.external_id is nullable. A block with no external_id did not
      // come from this provider's feed, so "the feed no longer lists it" says
      // nothing about it — leave it alone rather than cancelling it for being
      // absent from a set it was never going to be in.
      const toCancel = (existingBlocks ?? []).filter(
        (b) => b.external_id !== null && !currentExternalIds.has(b.external_id)
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

/**
 * Records that Hospitable no longer recognises this listing, and tells the PM.
 *
 * PAUSES, never deactivates. A 404 says the id is gone; it does not say whether
 * the customer delisted the property or relisted it under a new one, and only
 * they know which. Switching off a property row would take its bookings,
 * turnovers and every downstream cron with it on the strength of one status
 * code — see the column's own migration comment (20260823170441) for why that
 * asymmetry decides this.
 *
 * `.is('external_missing_since', null)` makes the timestamp mean FIRST seen
 * missing rather than most recently confirmed missing. That matters because it
 * is the only evidence of how long a listing has been gone, and the cron would
 * otherwise rewrite it to today's date every morning.
 */
async function markPropertyMissing(
  orgId:      string,
  propertyId: string,
): Promise<void> {
  const supabase = createServiceClient({ system: 'inngest:calendar-sync-handler' })

  const { data: property, error } = await supabase
    .from('properties')
    .update({ external_missing_since: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', propertyId)
    .is('external_missing_since', null)
    .select('name')
    .maybeSingle()

  if (error) throw new Error(`Marking property ${propertyId} missing failed: ${error.message}`)

  // No row updated means it was already marked on an earlier run. The
  // notification is deduped on the property anyway, but returning here keeps a
  // daily cron from re-entering the notify path at all.
  if (!property) return

  await createPmNotification(supabase, {
    orgId,
    type:  'integration.property_missing',
    title: `Hospitable no longer lists "${property.name}"`,
    // The external id is deliberately absent: a PM cannot act on a uuid, and
    // the property name plus the link is what lets them decide whether this was
    // a delisting or a relist under a new id.
    subtitle: 'Calendar sync for this property is paused until it reappears. If you relisted it, reconnect Hospitable to pick up the new listing.',
    href:     `/properties/${propertyId}`,
    severity: 'amber',
    dedupeKey: `property-missing:${propertyId}`,
  })
}
