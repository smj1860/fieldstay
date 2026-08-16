// lib/inngest/functions/hostex/initial-sync.ts
// ============================================================================
// Triggered by: integration/hostex.connected
//
// Steps:
//   1. read-token                    — a VALID token (refreshes if near expiry)
//   2. fetch-and-upsert-properties   — hostexFetchProperties → properties
//   3. seed-room-templates / apply-master-checklist-<id> — per new property
//   4. reservations → bookings → revenue → turnovers (shared pipeline)
//   4b. reviews backfill           — chunked into Hostex's <180-day windows
//   4c. staff → crew_members       — roles inferred from assigned task types
//   5. register-webhook            — ensure Hostex pushes changes to us
//   6. guidebook config sync
//   7. mark-complete
//
// Deliberately NOT here, with reasons, so the absences don't read as
// oversights:
//   - Crew IS imported, from /staffs — with roles inferred from /tasks, since
//     Hostex staff carry no role field of their own. See staff-sync.ts.
//   - No amenity-driven asset seeding. Hostex's /properties returns no
//     amenities at all, so seedPresentAssetsFromAmenities would run over an
//     empty set for every property — a step that can only ever no-op.
//   - No calendar-block sync. Blocks live on Hostex's availability endpoints,
//     not /reservations; out of scope for this phase.
// ============================================================================

import { inngest }             from '@/lib/inngest/client'
import { NonRetriableError }   from 'inngest'
import { translateSyncError }  from '@/lib/integrations/types'
import { reportError }         from '@/lib/observability/report-error'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { getValidHostexToken } from '@/lib/integrations/providers/hostex-token'
import { hostexFetchProperties } from '@/lib/integrations/providers/hostex-api'
import { ensureHostexWebhookRegistration } from '@/lib/integrations/providers/hostex-webhook'
import { hostexPropertyToNormalized } from '@/lib/integrations/providers/hostex.mappers'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import { applyChecklistsToProperties, syncGuidebookForOrg } from '../shared/property-onboarding'
import { syncHostexReservations } from './reservation-sync'
import { syncHostexReviews } from './reviews-sync'
import { syncHostexStaff } from './staff-sync'

const PROVIDER = 'hostex'
const SYSTEM   = 'inngest:hostex-initial-sync'

/**
 * How much history the first sync pulls back, in months.
 *
 * Hostex's /reservations defaults to "the next 180 days" when no date bounds
 * are sent, so history only exists if it is asked for explicitly. 12 months
 * is what makes an owner's first-year P&L meaningful — the whole point of
 * importing past stays rather than only future ones.
 */
const INITIAL_SYNC_HISTORY_MONTHS = 12

/** Matches the reconcile handler's lookahead — see the note there. */
const INITIAL_SYNC_LOOKAHEAD_MONTHS = 6

export const hostexInitialSync = inngest.createFunction(
  {
    id:      'hostex-initial-sync',
    name:    'Hostex: Initial Sync',
    retries: 4,
    // Per-org serialization plus a platform cap. The platform cap is less
    // critical than Hospitable's (Hostex quotas are per-token, so orgs do not
    // starve each other) but still bounds how much of the function budget one
    // wave of connects can occupy.
    concurrency: [
      { limit: 4 },
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/hostex.connected' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id, external_user_id } = event.data

    try {
      // ── 1. Token ──────────────────────────────────────────────────────────
      // getValidHostexToken, not readIntegrationToken: Hostex access tokens
      // live 7 days, and a connect that sat in a retry queue — or a resync of
      // an older connection — must not spend an expired one.
      const token = await step.run('read-token', async () => {
        const t = await getValidHostexToken(user_id)
        if (!t) throw new NonRetriableError('No Hostex token found — reconnect required')
        return t
      })

      // ── 2. Properties ─────────────────────────────────────────────────────
      const propertyIdMap = await step.run('fetch-and-upsert-properties', async () => {
        const properties = await hostexFetchProperties(token, user_id)
        logger.info(`[Hostex:${user_id}] Fetched ${properties.length} properties`)

        if (!properties.length) return {}

        return upsertNormalizedProperties(org_id, PROVIDER, properties.map(hostexPropertyToNormalized))
      })

      const propertyIds = Object.values(propertyIdMap as Record<string, string>)

      // ── 3. Checklists for the new properties ──────────────────────────────
      await applyChecklistsToProperties(step, org_id, propertyIds, SYSTEM)

      // ── 4. Reservations → bookings → revenue → turnovers ──────────────────
      // revenueMode 'all': the post is idempotent, and firing broadly is what
      // lets a manual resync REPAIR an org whose revenue post failed earlier.
      const { reservationCount } = await syncHostexReservations({
        step,
        logger,
        token,
        orgId:           org_id,
        userId:          user_id,
        propertyIdMap: propertyIdMap as Record<string, string>,
        fetchMode: {
          kind:            'window',
          historyMonths:   INITIAL_SYNC_HISTORY_MONTHS,
          lookaheadMonths: INITIAL_SYNC_LOOKAHEAD_MONTHS,
        },
        system:      SYSTEM,
        revenueMode: 'all',
      })

      // ── 4b. Reviews ───────────────────────────────────────────────────────
      // After reservations, because the guest-name backfill reads the bookings
      // this org just imported — run first, every Hostex review would be
      // anonymous until the next sweep.
      const { reviewCount } = await syncHostexReviews({
        step,
        logger,
        token,
        orgId:         org_id,
        userId:        user_id,
        propertyIdMap: propertyIdMap as Record<string, string>,
        fetchMode:     { kind: 'window', historyMonths: INITIAL_SYNC_HISTORY_MONTHS },
        system:        SYSTEM,
        stepPrefix:    'initial',
      })

      // ── 4c. Staff → crew members ──────────────────────────────────────────
      // Non-fatal: a PM whose crew fails to import still has properties,
      // bookings and reviews, and the daily reconcile retries. Failing the
      // whole sync here would throw all of that away.
      let crewCount = 0
      try {
        ;({ crewCount } = await syncHostexStaff({
          step, logger, token,
          orgId:      org_id,
          userId:     user_id,
          system:     SYSTEM,
          stepPrefix: 'initial',
        }))
      } catch (err) {
        logger.error(`[Hostex:${user_id}] staff import failed: ${err instanceof Error ? err.message : String(err)}`)
        reportError(err, { site: 'inngest.hostex-initial-sync.staff', orgId: org_id })
      }

      // ── 5. Register the inbound webhook ───────────────────────────────────
      // AFTER properties, deliberately. A delivery that arrives before the
      // property map exists is skipped as unknown_property, so registering
      // first would guarantee a window where real reservation events are
      // dropped on the floor.
      //
      // Non-fatal: a failure here costs real-time updates, not correctness —
      // hostexReservationReconcileCron still sweeps daily. Failing the whole
      // sync over it would throw away the properties and bookings already
      // imported.
      await step.run('register-webhook', async () => {
        try {
          const { attempted, created } = await ensureHostexWebhookRegistration(user_id, token)

          if (!attempted) {
            logger.warn(`[Hostex:${user_id}] NEXT_PUBLIC_APP_URL unset — skipping webhook registration`)
            return { registered: false }
          }

          logger.info(`[Hostex:${user_id}] Webhook ${created ? 'registered' : 'already registered'}`)
          // A summary, never the token — Inngest persists step return values.
          return { registered: true, created }
        } catch (err) {
          logger.error(`[Hostex:${user_id}] webhook registration failed: ${err instanceof Error ? err.message : String(err)}`)
          reportError(err, { site: 'inngest.hostex-initial-sync.register-webhook', orgId: org_id })
          // Non-fatal — see above.
          return { registered: false }
        }
      })

      // ── 6. Guidebook ──────────────────────────────────────────────────────
      await syncGuidebookForOrg(step, logger, org_id, PROVIDER, `[Hostex:${user_id}]`)

      // ── 7. Mark complete ──────────────────────────────────────────────────
      await step.run('mark-complete', async () => {
        await mergeIntegrationConnectionMetadata({
          userId:     user_id,
          providerId: PROVIDER,
          patch: {
            last_sync_status:  'success',
            last_sync_error:   null,
            last_synced_at:    new Date().toISOString(),
            last_sync_count:   reservationCount,
            properties_found:  propertyIds.length,
            bookings_found:    reservationCount,
            reviews_found:     reviewCount,
            crew_found:        crewCount,
            external_user_id,
          },
        })
      })

      logger.info(
        `[Hostex:${user_id}] Initial sync complete — ` +
        `${propertyIds.length} properties, ${reservationCount} bookings, ` +
        `${reviewCount} reviews, ${crewCount} crew`
      )

      return {
        properties:   propertyIds.length,
        reservations: reservationCount,
        reviews:      reviewCount,
        crew:         crewCount,
      }
    } catch (err) {
      const msg         = err instanceof Error ? err.message : String(err)
      const friendlyMsg = translateSyncError(err, 'Hostex')
      logger.error(`[Hostex:${user_id}] initial sync failed: ${msg}`)
      reportError(err, { site: 'inngest.hostex-initial-sync' })

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
