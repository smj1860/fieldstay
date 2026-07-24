// lib/inngest/functions/ownerrez/reconciliation-handler.ts
// ============================================================
// Triggered by: integration/ownerrez.reconcile.requested
// Fired by:     ownerRezReconciliationCron, once daily per active
//               OwnerRez connection.
//
// Fetches the org's CURRENT full booking list from OwnerRez (getBookings()
// with no since_utc — the same full-listing call initial-sync.ts already
// uses) and cancels any non-cancelled FieldStay booking whose external_id
// no longer appears in that fresh set. This is the only path that can ever
// detect a hard delete: incremental-sync.ts's since_utc-filtered fetch
// can't distinguish "unchanged since last cursor" from "silently removed
// upstream" — it just never sees the record again.
//
// Any turnover depending on a newly-cancelled booking is cancelled too
// (cancelTurnoversForBooking), same as iCal sync does on a real
// cancellation — otherwise a stale turnover would still get scheduled for
// a stay that turned out to not exist.
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient }    from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import { cancelTurnoversForBooking } from '@/lib/turnovers/generator'

const PROVIDER = 'ownerrez'

export const ownerRezReconciliationHandler = inngest.createFunction(
  {
    id:      'ownerrez-reconciliation-handler',
    name:    'OwnerRez: Hard-Delete Reconciliation Handler',
    retries: 2,
    concurrency: { limit: 2, key: 'event.data.org_id' },
  },
  { event: 'integration/ownerrez.reconcile.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    // Deliberately NOT filtered to is_active properties — cancel-stale-bookings
    // below compares against every non-cancelled booking for the org with no
    // property filter at all. Scoping this fetch to active properties only
    // meant a booking on a property the PM had deactivated in FieldStay (but
    // which still exists in OwnerRez) was never included in the "current"
    // set below, so it always looked stale and got cancelled — every day,
    // for as long as the property stayed inactive. Both queries must agree
    // on scope; matching this one to the unfiltered existing-bookings query
    // (rather than the other way around) keeps reconciliation reflecting
    // OwnerRez's real state regardless of FieldStay's local active flag.
    const propertyIds = await step.run('fetch-property-ids', async () => {
      const supabase = createServiceClient({ system: 'inngest:reconciliation-handler' })

      const { data } = await supabase
        .from('properties')
        .select('external_id')
        .eq('org_id', org_id)
        .eq('external_source', PROVIDER)

      return ((data ?? []) as Array<{ external_id: string | null }>)
        .map((p) => Number(p.external_id))
        .filter((id) => !Number.isNaN(id))
    })

    if (propertyIds.length === 0) {
      return { skipped: true, reason: 'no_properties' }
    }

    let currentExternalIdList: string[]
    try {
      // Returns a plain array, not a Set — step.run's result is JSON-
      // serialized for memoization, and a Set doesn't survive that
      // round-trip (JSON.stringify(new Set(...)) produces "{}").
      currentExternalIdList = await step.run('fetch-current-bookings', async () => {
        const client   = new OwnerRezApiClient(user_id)
        const bookings = await client.getBookings({ propertyIds })
        return bookings.map((b) => String(b.id))
      })
    } catch (err) {
      if (err instanceof RateLimitError) {
        logger.warn(`[OwnerRez reconciliation] org ${org_id} rate limited — will retry next cycle`)
        return { skipped: true, reason: 'rate_limited' }
      }
      if (err instanceof TokenRevokedError) {
        logger.error(`[OwnerRez reconciliation] org ${org_id} token revoked: ${translateSyncError(err)}`)
        return { skipped: true, reason: 'token_revoked' }
      }
      throw err
    }

    const currentExternalIds = new Set(currentExternalIdList)

    const result = await step.run('cancel-stale-bookings', async () => {
      const supabase = createServiceClient({ system: 'inngest:reconciliation-handler' })

      const { data: existing, error } = await supabase
        .from('bookings')
        .select('id, external_id')
        .eq('org_id', org_id)
        .eq('external_source', PROVIDER)
        .neq('status', 'cancelled')

      if (error) throw new Error(`Fetching existing bookings failed: ${error.message}`)

      const stale = (existing ?? []).filter(
        (b) => b.external_id !== null && !currentExternalIds.has(b.external_id)
      )

      let cancelledCount = 0

      for (const booking of stale) {
        const { error: cancelErr } = await supabase
          .from('bookings')
          .update({ status: 'cancelled' })
          .eq('id', booking.id)

        if (cancelErr) {
          logger.error(`[OwnerRez reconciliation] failed to cancel booking ${booking.id}: ${cancelErr.message}`)
          continue
        }

        await cancelTurnoversForBooking(booking.id, supabase)
        cancelledCount++
      }

      return { cancelledCount }
    })

    logger.info(
      `[OwnerRez reconciliation] org ${org_id}: ${result.cancelledCount} stale booking(s)/hold(s) cancelled`
    )

    return result
  }
)
