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

import { fetchAllRows } from '@/lib/inngest/paginate'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { OwnerRezApiClient }    from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import { cancelTurnoversForBooking, notifyCrewOfCancelledTurnovers, type CancelledTurnoverAssignment } from '@/lib/turnovers/generator'

import { reportError } from '@/lib/observability/report-error'
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

      // Paginated, and it throws on failure. Both matter here: an empty list
      // means "reconcile nothing", so a failed read made the whole sweep a
      // silent no-op that still reported success — and a truncated read at
      // PostgREST's max_rows = 1000 would quietly reconcile only part of a
      // large org's portfolio, which looks identical to a clean run.
      const data = await fetchAllRows<{ external_id: string | null }>(
        (from, to) => supabase
          .from('properties')
          .select('external_id')
          .eq('org_id', org_id)
          .eq('external_source', PROVIDER)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `properties(ownerrez-reconciliation)[org=${org_id}]` },
      )

      return data
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
        reportError(err, { site: 'inngest.ownerrez-reconciliation-handler.fetch-current-bookings' })
        return { skipped: true, reason: 'rate_limited' }
      }
      if (err instanceof TokenRevokedError) {
        logger.error(`[OwnerRez reconciliation] org ${org_id} token revoked: ${translateSyncError(err)}`)
        return { skipped: true, reason: 'token_revoked' }
      }
      throw err
    }

    const currentExternalIds = new Set(currentExternalIdList)

    // An EMPTY current set is not "everything was deleted upstream".
    //
    // This whole function reconciles by absence — the header says so, and that
    // is the only way a hard delete is ever detectable. But absence-as-signal
    // has one degenerate input: if getBookings() comes back empty, every
    // non-cancelled OwnerRez booking in the org is absent, so the pass below
    // cancelled ALL of them, cancelled their turnovers, and texted the crew
    // that their jobs were off. Daily, for one bad API response.
    //
    // getBookings() throws on a non-2xx, so this is specifically the 200-with-
    // nothing case: an upstream hiccup, a propertyIds filter that stopped
    // matching, or a genuinely emptied account. Those are indistinguishable
    // here, and the asymmetry decides it — declining to cancel leaves stale
    // rows for one more day, cancelling wrongly sends crew home from stays
    // that are still happening. Mirrors the same guard in ical-sync.ts.
    if (currentExternalIds.size === 0) {
      logger.error(
        `[OwnerRez reconciliation] org ${org_id}: OwnerRez returned ZERO bookings for ` +
        `${propertyIds.length} propert${propertyIds.length === 1 ? 'y' : 'ies'} — ` +
        `skipping the stale-booking pass rather than cancelling everything`
      )
      reportError(new Error('OwnerRez reconciliation returned zero bookings'), {
        site:  'inngest.ownerrez-reconciliation-handler.empty-result-guard',
        orgId: org_id,
        extra: { property_count: propertyIds.length },
      })
      return { skipped: true, reason: 'empty_current_set' }
    }

    const result = await step.run('cancel-stale-bookings', async () => {
      const supabase = createServiceClient({ system: 'inngest:reconciliation-handler' })

      // Paginated, for the reason this file already gives for the property
      // read above: at PostgREST's max_rows = 1000 a truncated page here does
      // not merely miss rows — every booking past the cap is absent from
      // `existing`, so it is never considered, and the sweep silently stops
      // reconciling the older half of a long-lived org's calendar while
      // reporting a clean run.
      const existing = await fetchAllRows<{ id: string; external_id: string | null }>(
        (from, to) => supabase
          .from('bookings')
          .select('id, external_id')
          .eq('org_id', org_id)
          .eq('external_source', PROVIDER)
          .neq('status', 'cancelled')
          .order('id', { ascending: true })
          .range(from, to),
        { label: `bookings(ownerrez-reconciliation)[org=${org_id}]` },
      )

      const stale = existing.filter(
        (b) => b.external_id !== null && !currentExternalIds.has(b.external_id)
      )

      let cancelledCount = 0
      const cancelledAssignments: CancelledTurnoverAssignment[] = []

      for (const booking of stale) {
        const { error: cancelErr } = await supabase
          .from('bookings')
          .update({ status: 'cancelled' })
          .eq('id', booking.id)
          .eq('org_id', org_id)

        if (cancelErr) {
          logger.error(`[OwnerRez reconciliation] failed to cancel booking ${booking.id}: ${cancelErr.message}`)
          continue
        }

        cancelledAssignments.push(...(await cancelTurnoversForBooking(booking.id, supabase)))
        cancelledCount++
      }

      return { cancelledCount, cancelledAssignments }
    })

    await step.run('notify-crew-cancelled-turnovers', async () => {
      await notifyCrewOfCancelledTurnovers(result.cancelledAssignments)
    })

    logger.info(
      `[OwnerRez reconciliation] org ${org_id}: ${result.cancelledCount} stale booking(s)/hold(s) cancelled`
    )

    return { cancelledCount: result.cancelledCount }
  }
)
