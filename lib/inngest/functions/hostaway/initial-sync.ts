// lib/inngest/functions/hostaway/initial-sync.ts
// ============================================================================
// Triggered by: integration/hostaway.sync.requested
//
// Steps:
//   1. read-token                    — the Bearer token from Vault
//   2. fetch-and-upsert-properties   — hostawayFetchListings → properties
//   3. seed-room-templates / apply-master-checklist-<id> — per new property
//   4. reservations → bookings → revenue → turnovers (shared pipeline)
//   5. guidebook config sync
//   6. mark-complete
//
// STILL DISABLED — not registered in app/api/inngest/route.ts's serve() array,
// and the provider is not in lib/integrations/registry.ts, so nothing can
// trigger this. See docs/HOSTAWAY_ENABLEMENT.md for the remaining phases.
//
// This is a REWRITE of the 2026-07-25 version, not a patch. That version
// hand-rolled its own `properties` upsert and its own booking upsert, and in
// doing so it:
//
//   - never emitted `booking/confirmed`, so no revenue reached
//     owner_transactions — the documented reason it was switched off;
//   - invented room counts (`bedrooms: listing.bedrooms ?? 1`), overwriting a
//     PM's correction on every sync;
//   - kept no audit trail when it overwrote the four PM-editable content
//     fields;
//   - seeded no room templates, checklists or guidebook config, so a Hostaway
//     org's imported properties arrived inert.
//
// All four are properties of NOT going through the shared writers. Going
// through them is the fix, so the mapping moved to
// lib/integrations/providers/hostaway.mappers.ts and everything else is now
// upsertNormalizedProperties + runReservationPipeline + the shared onboarding
// helpers — the same spine Hostex and Hospitable use.
//
// Deliberately NOT here, with reasons, so the absences don't read as
// oversights:
//   - No calendar-block sync. Manually-blocked owner time does not appear
//     through /reservations; it lives on Hostaway's calendar endpoints. Same
//     position Hostex shipped with.
//   - No crew import. Hostaway has no staff/teammate concept equivalent to
//     Hostex's /staffs or Hospitable's teammates.
//   - No reviews yet, and no webhook registration yet — both are later phases
//     with working Hostex templates to mirror.
//   - No amenity-driven asset seeding: GET /listings with includeResources=0,
//     which is what the fetcher requests, returns no amenities at all.
// ============================================================================

import { inngest }              from '@/lib/inngest/client'
import { NonRetriableError }    from 'inngest'
import { translateSyncError }   from '@/lib/integrations/types'
import { reportError }          from '@/lib/observability/report-error'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { hostawayFetchListings } from '@/lib/integrations/providers/hostaway'
import { hostawayListingToNormalized } from '@/lib/integrations/providers/hostaway.mappers'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import { applyChecklistsToProperties, syncGuidebookForOrg } from '../shared/property-onboarding'
import { syncHostawayReservations } from './reservation-sync'

const PROVIDER = 'hostaway'
const SYSTEM   = 'inngest:hostaway-initial-sync'

/**
 * How much history the first sync pulls back, in months.
 *
 * Hostaway's GET /reservations defaults to 90 days when no `dateFrom` is sent,
 * so anything older only exists if it is asked for. 12 months matches Hostex
 * and is what makes an owner's first-year P&L meaningful.
 */
const INITIAL_SYNC_HISTORY_MONTHS = 12

export const hostawayInitialSync = inngest.createFunction(
  {
    id:      'hostaway-initial-sync',
    name:    'Hostaway: Initial Sync',
    retries: 4,
    // Per-org serialization plus a platform cap. Hostaway rate limits per
    // account token, so orgs do not starve each other, but the cap still
    // bounds how much of the function budget one wave of connects can take.
    concurrency: [
      { limit: 4 },
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/hostaway.sync.requested' },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data

    try {
      // ── 1. Token ────────────────────────────────────────────────────────────
      // readIntegrationToken, NOT a getValid*Token wrapper like Hostex's:
      // Hostaway issues a ~6-month Bearer token from an Account ID + API Key
      // exchange and there is no refresh grant, so there is nothing to refresh
      // toward. An expired token surfaces as a 401 from the first fetch below
      // and is translated for the PM by translateSyncError.
      //
      // NonRetriableError on absence: a missing token cannot be fixed by
      // retrying, only by reconnecting.
      const token = await step.run('read-token', async () => {
        const t = await readIntegrationToken(user_id, PROVIDER)
        if (!t) throw new NonRetriableError('No Hostaway token found — reconnect required')
        return t
      })

      // ── 2. Properties ───────────────────────────────────────────────────────
      const propertyIdMap = await step.run('fetch-and-upsert-properties', async () => {
        const listings = await hostawayFetchListings(token)
        logger.info(`[Hostaway:${user_id}] Fetched ${listings.length} listings`)

        if (!listings.length) return {}

        return upsertNormalizedProperties(org_id, PROVIDER, listings.map(hostawayListingToNormalized))
      })

      const propertyIds = Object.values(propertyIdMap as Record<string, string>)

      // ── 3. Checklists for the new properties ────────────────────────────────
      await applyChecklistsToProperties(step, org_id, propertyIds, SYSTEM)

      // ── 4. Reservations → bookings → revenue → turnovers ────────────────────
      // revenueMode 'all': the post is idempotent (booking-events.ts upserts
      // ON CONFLICT (source_reference_id, source) DO NOTHING), and firing
      // broadly is what lets a manual resync REPAIR an org whose revenue post
      // failed earlier.
      const { reservationCount } = await syncHostawayReservations({
        step,
        logger,
        token,
        orgId:         org_id,
        userId:        user_id,
        propertyIdMap: propertyIdMap as Record<string, string>,
        fetchMode:     { kind: 'window', historyMonths: INITIAL_SYNC_HISTORY_MONTHS },
        system:        SYSTEM,
        revenueMode:   'all',
      })

      // ── 5. Guidebook ────────────────────────────────────────────────────────
      await syncGuidebookForOrg(step, logger, org_id, PROVIDER, `[Hostaway:${user_id}]`)

      // ── 6. Mark complete ────────────────────────────────────────────────────
      await step.run('mark-complete', async () => {
        await mergeIntegrationConnectionMetadata({
          userId:     user_id,
          providerId: PROVIDER,
          patch: {
            last_sync_status: 'success',
            last_sync_error:  null,
            last_synced_at:   new Date().toISOString(),
            last_sync_count:  reservationCount,
            properties_found: propertyIds.length,
            bookings_found:   reservationCount,
          },
        })
      })

      logger.info(
        `[Hostaway:${user_id}] Initial sync complete — ` +
        `${propertyIds.length} properties, ${reservationCount} bookings`
      )

      return {
        properties:   propertyIds.length,
        reservations: reservationCount,
      }
    } catch (err) {
      const msg         = err instanceof Error ? err.message : String(err)
      const friendlyMsg = translateSyncError(err, 'Hostaway')
      logger.error(`[Hostaway:${user_id}] initial sync failed: ${msg}`)
      reportError(err, { site: 'inngest.hostaway-initial-sync' })

      await step.run('handle-failure', async () => {
        await mergeIntegrationConnectionMetadata({
          userId:     user_id,
          providerId: PROVIDER,
          status:     'error',
          patch: {
            last_sync_status: 'error',
            last_sync_error:  friendlyMsg,
            last_synced_at:   new Date().toISOString(),
          },
        })
      })

      throw err
    }
  }
)
