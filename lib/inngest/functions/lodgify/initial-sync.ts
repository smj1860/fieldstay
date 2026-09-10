// lib/inngest/functions/lodgify/initial-sync.ts
// ============================================================================
// Triggered by: integration/lodgify.sync.requested
//
// Steps:
//   1. token                         — a getter, never a hoisted step value
//   2. fetch-and-upsert-properties   — lodgifyFetchProperties → properties
//   3. seed-room-templates / apply-master-checklist-<id> — per new property
//   4. bookings → revenue → turnovers (shared pipeline)
//   5. register-webhook              — gated OFF by default, see below
//   6. guidebook config sync
//   7. mark-complete
//
// Deliberately NOT here, with reasons, so the absences don't read as
// oversights:
//   - No reviews import. Lodgify's Public API exposes no reviews resource at
//     all — unlike Hostex and Hostaway, there is nothing to read.
//   - No crew import. Lodgify has no staff/teammate concept equivalent to
//     Hostex's /staffs or Hospitable's teammates.
//   - No calendar-block sync. Blocks live on Lodgify's availability
//     endpoints, not on /reservations/bookings. Same position Hostex and
//     Hostaway shipped with.
//   - No amenity-driven asset seeding. The property shape carries no amenity
//     map, so seedPresentAssetsFromAmenities would run over an empty set for
//     every property — a step that can only ever no-op.
//   - No guest messaging. Lodgify HAS a messaging resource; nothing in
//     FieldStay consumes a PMS thread today, so reading one would be data we
//     store and never show.
// ============================================================================

import { inngest }             from '@/lib/inngest/client'
import { reconnectRequired }   from '@/lib/inngest/reconnect-required'
import { translateSyncError }  from '@/lib/integrations/types'
import { reportError }         from '@/lib/observability/report-error'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { lodgifyFetchProperties } from '@/lib/integrations/providers/lodgify-api'
import { ensureLodgifyWebhookRegistration } from '@/lib/integrations/providers/lodgify-webhook'
import {
  isLodgifyPropertyImportable,
  lodgifyPropertyToNormalized,
} from '@/lib/integrations/providers/lodgify.mappers'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import { applyChecklistsToProperties, syncGuidebookForOrg } from '../shared/property-onboarding'
import { syncLodgifyReservations } from './reservation-sync'

const PROVIDER = 'lodgify'
const SYSTEM   = 'inngest:lodgify-initial-sync'

/**
 * How much history the first sync pulls back, in months.
 *
 * 12 months matches Hostex and Hostaway, and is what makes an owner's
 * first-year P&L meaningful — the whole point of importing past stays rather
 * than only future ones.
 */
const INITIAL_SYNC_HISTORY_MONTHS = 12

/** Matches the reconcile handler's lookahead — see the note there. */
const INITIAL_SYNC_LOOKAHEAD_MONTHS = 6

export const lodgifyInitialSync = inngest.createFunction(
  {
    id:      'lodgify-initial-sync',
    name:    'Lodgify: Initial Sync',
    retries: 4,
    // Per-org serialization plus a platform cap. Lodgify quotas are per
    // account key, so orgs do not starve each other; the cap still bounds how
    // much of the function budget one wave of connects can occupy.
    concurrency: [
      { limit: 4 },
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/lodgify.sync.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id, external_user_id } = event.data

    try {
      // ── 1. Credential ─────────────────────────────────────────────────────
      // readIntegrationToken, not a getValid*Token wrapper: a Lodgify API key
      // is long-lived and has no refresh grant, so there is nothing to refresh
      // toward. A key the PM rotated in Lodgify surfaces as a 401 from the
      // first fetch below and is translated for them by translateSyncError.
      //
      // A GETTER, invoked inside each step that spends it — see the
      // "credentials are not step state" note in
      // lib/integrations/providers/hospitable-token.ts.
      const getToken = async () => {
        const t = await readIntegrationToken(user_id, PROVIDER)
        if (!t) throw reconnectRequired('No Lodgify API key found — reconnect required')
        return t
      }

      // ── 2. Properties ─────────────────────────────────────────────────────
      const propertyIdMap = await step.run('fetch-and-upsert-properties', async () => {
        const properties = await lodgifyFetchProperties(await getToken(), user_id)
        const importable = properties.filter(isLodgifyPropertyImportable)

        logger.info(
          `[Lodgify:${user_id}] Fetched ${properties.length} properties ` +
          `(${importable.length} importable)`
        )

        if (!importable.length) return {}

        return upsertNormalizedProperties(org_id, PROVIDER, importable.map(lodgifyPropertyToNormalized))
      })

      const propertyIds = Object.values(propertyIdMap as Record<string, string>)

      // ── 3. Checklists for the new properties ──────────────────────────────
      await applyChecklistsToProperties(step, org_id, propertyIds, SYSTEM)

      // ── 4. Bookings → revenue → turnovers ─────────────────────────────────
      // revenueMode 'all': the post is idempotent, and firing broadly is what
      // lets a manual resync REPAIR an org whose revenue post failed earlier.
      const { reservationCount } = await syncLodgifyReservations({
        step,
        logger,
        getToken,
        orgId:         org_id,
        userId:        user_id,
        propertyIdMap: propertyIdMap as Record<string, string>,
        fetchMode: {
          kind:            'window',
          historyMonths:   INITIAL_SYNC_HISTORY_MONTHS,
          lookaheadMonths: INITIAL_SYNC_LOOKAHEAD_MONTHS,
        },
        system:      SYSTEM,
        revenueMode: 'all',
      })

      // ── 5. Register the inbound webhook ───────────────────────────────────
      // AFTER properties, deliberately. A delivery that arrives before the
      // property map exists is skipped as unknown_property, so registering
      // first would guarantee a window where real booking events are dropped.
      //
      // OFF BY DEFAULT: ensureLodgifyWebhookRegistration is gated on
      // LODGIFY_WEBHOOKS_ENABLED and returns { attempted: false } when it is
      // unset. See that module's header — registration is the one call here
      // that writes to the PM's own Lodgify account, and its request shape is
      // documented rather than verified. With it off the org still syncs
      // daily via lodgifyReservationReconcileCron.
      //
      // Non-fatal either way: a failure here costs latency, not correctness.
      await step.run('register-webhook', async () => {
        try {
          const { attempted, created, reason } = await ensureLodgifyWebhookRegistration(user_id, await getToken())

          if (!attempted) {
            logger.info(`[Lodgify:${user_id}] Webhook registration skipped (${reason}) — daily reconcile covers this org`)
            return { registered: false }
          }

          logger.info(`[Lodgify:${user_id}] Webhooks registered — ${created} newly subscribed`)
          // A summary, never the token — Inngest persists step return values.
          return { registered: true, created }
        } catch (err) {
          logger.error(`[Lodgify:${user_id}] webhook registration failed: ${err instanceof Error ? err.message : String(err)}`)
          reportError(err, { site: 'inngest.lodgify-initial-sync.register-webhook', orgId: org_id })
          return { registered: false }
        }
      })

      // ── 6. Guidebook ──────────────────────────────────────────────────────
      await syncGuidebookForOrg(step, logger, org_id, PROVIDER, `[Lodgify:${user_id}]`)

      // ── 7. Mark complete ──────────────────────────────────────────────────
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
            external_user_id,
          },
        })
      })

      logger.info(
        `[Lodgify:${user_id}] Initial sync complete — ` +
        `${propertyIds.length} properties, ${reservationCount} bookings`
      )

      return { properties: propertyIds.length, reservations: reservationCount }
    } catch (err) {
      const msg         = err instanceof Error ? err.message : String(err)
      const friendlyMsg = translateSyncError(err, 'Lodgify')
      logger.error(`[Lodgify:${user_id}] initial sync failed: ${msg}`)
      reportError(err, { site: 'inngest.lodgify-initial-sync' })

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
