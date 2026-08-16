// lib/inngest/functions/hostex/initial-sync.ts
// ============================================================================
// Triggered by: integration/hostex.connected
//
// Steps:
//   1. read-token                    — a VALID token (refreshes if near expiry)
//   2. fetch-and-upsert-properties   — hostexFetchProperties → properties
//   3. seed-room-templates / apply-master-checklist-<id> — per new property
//   4. reservations → bookings → revenue → turnovers (shared pipeline)
//   5. guidebook config sync
//   6. mark-complete
//
// Deliberately NOT here, with reasons, so the absences don't read as
// oversights:
//   - No teammate/crew import. Hostex has no teammate endpoint.
//   - No amenity-driven asset seeding. Hostex's /properties returns no
//     amenities at all, so seedPresentAssetsFromAmenities would run over an
//     empty set for every property — a step that can only ever no-op.
//   - No calendar-block sync. Blocks live on Hostex's availability endpoints,
//     not /reservations; out of scope for this phase.
// ============================================================================

import { inngest }             from '@/lib/inngest/client'
import { NonRetriableError }   from 'inngest'
import { createServiceClient } from '@/lib/supabase/server'
import { translateSyncError }  from '@/lib/integrations/types'
import { reportError }         from '@/lib/observability/report-error'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { getValidHostexToken } from '@/lib/integrations/providers/hostex-token'
import { hostexFetchProperties } from '@/lib/integrations/providers/hostex-api'
import { hostexPropertyToNormalized } from '@/lib/integrations/providers/hostex.mappers'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import {
  applyMasterChecklistToProperty,
  fetchOrgRoomTemplateData,
  type OrgRoomTemplateData,
} from '@/lib/checklists/apply-master-template'
import { seedDefaultRoomTemplatesIfNeeded } from '@/lib/checklists/seed-default-room-templates'
import {
  ensureGuidebookConfiguration,
  createGuidebookPropertyConfigsForProperties,
  syncGuidebookConfigsFromProperty,
} from '@/lib/guidebook/sync'
import { syncHostexReservations } from './reservation-sync'

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
      // Seeded and fetched once for the whole run rather than once per
      // property — applyMasterChecklistToProperty otherwise re-reads identical
      // org-level data for every property in the loop.
      let orgRoomData: OrgRoomTemplateData | undefined

      if (propertyIds.length > 0) {
        await step.run('seed-room-templates', async () => {
          await seedDefaultRoomTemplatesIfNeeded(org_id)
        })

        orgRoomData = await step.run('fetch-room-template-data', async () => {
          const supabase = createServiceClient({ system: SYSTEM })
          return fetchOrgRoomTemplateData(org_id, supabase)
        })
      }

      for (const propertyId of propertyIds) {
        await step.run(`apply-master-checklist-${propertyId}`, async () => {
          const supabase = createServiceClient({ system: SYSTEM })
          await applyMasterChecklistToProperty(propertyId, org_id, supabase, {
            orgRoomData,
            skipSeed: true,
          })
        })
      }

      // ── 4. Reservations → bookings → revenue → turnovers ──────────────────
      // revenueMode 'all': the post is idempotent, and firing broadly is what
      // lets a manual resync REPAIR an org whose revenue post failed earlier.
      const { reservationCount } = await syncHostexReservations({
        step,
        logger,
        token,
        orgId:           org_id,
        userId:          user_id,
        propertyIdMap:   propertyIdMap as Record<string, string>,
        historyMonths:   INITIAL_SYNC_HISTORY_MONTHS,
        lookaheadMonths: INITIAL_SYNC_LOOKAHEAD_MONTHS,
        system:          SYSTEM,
        revenueMode:     'all',
      })

      // ── 5. Guidebook ──────────────────────────────────────────────────────
      await step.run('create-guidebook-org-config', async () => {
        await ensureGuidebookConfiguration(org_id)
      })

      await step.run('create-guidebook-property-configs', async () => {
        try {
          await createGuidebookPropertyConfigsForProperties(org_id)
        } catch (err) {
          logger.error(`[Hostex:${user_id}] guidebook config creation failed: ${err instanceof Error ? err.message : String(err)}`)
          reportError(err, { site: 'inngest.hostex-initial-sync.create-guidebook-property-configs' })
          // Non-fatal — don't block the sync.
        }
      })

      await step.run('sync-guidebook-configs-from-property', async () => {
        await syncGuidebookConfigsFromProperty(org_id, PROVIDER)
      })

      // ── 6. Mark complete ──────────────────────────────────────────────────
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
            external_user_id,
          },
        })
      })

      logger.info(
        `[Hostex:${user_id}] Initial sync complete — ` +
        `${propertyIds.length} properties, ${reservationCount} bookings`
      )

      return { properties: propertyIds.length, reservations: reservationCount }
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
