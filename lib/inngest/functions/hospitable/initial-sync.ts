// lib/inngest/functions/hospitable/initial-sync.ts
// ============================================================
// Triggered by: integration/hospitable.connected
// Steps:
//  1. read-token              — pull Bearer token from Vault
//  2. fetch-and-upsert-props  — hospFetchProperties → upsert to properties
//  3. apply-master-checklist  — applyMasterChecklistToProperty per new property
//  3b. seed-asset-discovery-from-amenities — seedPresentAssetsFromAmenities per confirmed amenity
//  4. fetch-and-upsert-teammates — hospFetchTeammates → upsert to crew_members
//  5. fetch-reservations-window-<date> (one step per window) + upsert-reservations
//     — hospReservationWindows/fetchReservationsWindow → upsert to bookings.
//     One step per window so a rate-limit throw on a later window doesn't
//     re-fetch windows already fetched successfully.
//  6. generate-turnovers      — generateTurnoversForProperty per affected property
//  7. guidebook config sync   — ensureGuidebookConfiguration / createGuidebookPropertyConfigsForProperties / syncGuidebookConfigsFromProperty
//  8. mark-complete           — write last_sync_status to integration_connections
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { NonRetriableError }   from 'inngest'
import { createServiceClient } from '@/lib/supabase/server'
import { readIntegrationToken } from '@/lib/integrations/vault'
import { translateSyncError } from '@/lib/integrations/types'
import {
  hospFetchProperties,
  hospFetchTeammates,
  hospitablePropertyToNormalized,
  hospitableTeammatesToCrewRows,
} from '@/lib/integrations/providers/hospitable'
import { syncHospitableReservations } from './reservation-sync'
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
import {
  seedPresentAssetsFromAmenities,
  seedAbsentOptionalAssetsFromAmenities,
} from '@/lib/asset-discovery/seed-from-amenities'

import { reportError } from '@/lib/observability/report-error'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
const PROVIDER = 'hospitable'

// Initial sync backfills 3 months forward, not the 6 that
// RESERVATION_LOOKAHEAD_MONTHS uses for resyncs. Anything further out still
// arrives via the incremental webhook path (which fetches a single
// reservation by id and is unaffected by windowing), so this only bounds how
// much of the future a FIRST sync pre-loads — halving time-to-first-render
// on a large portfolio and halving the shared rate-limit budget one connect
// consumes.
const INITIAL_SYNC_LOOKAHEAD_MONTHS = 3

export const hospInitialSync = inngest.createFunction(
  {
    id:      'hospitable-initial-sync',
    name:    'Hospitable: Initial Sync',
    // 4 retries (was 2): hospitableApiLimiter is a single platform-wide
    // budget, so two orgs connecting in the same minute WILL rate-limit each
    // other. With per-window steps (below) a retry resumes rather than
    // restarts, so the extra attempts are cheap.
    retries: 4,
    // Two limits: per-org (unchanged — one sync per org at a time) plus a
    // PLATFORM cap. Without the second, N simultaneous connects fan out N-wide
    // against one shared 54-req/min Hospitable budget and every one of them
    // fails. Queueing is strictly better than collective starvation.
    concurrency: [
      { limit: 2 },
      { limit: 1, key: 'event.data.org_id' },
    ],
  },
  { event: 'integration/hospitable.connected' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id, external_user_id } = event.data

    try {
      // ── 1. Read token from Vault ─────────────────────────────────────────
      const token = await step.run('read-token', async () => {
        const t = await readIntegrationToken(user_id, PROVIDER)
        if (!t) throw new NonRetriableError('No Hospitable token found — reconnect required')
        return t
      })

      // ── 2. Fetch properties and upsert ───────────────────────────────────
      const propertyIdMap = await step.run('fetch-and-upsert-properties', async () => {
        const properties = await hospFetchProperties(token)
        logger.info(`[Hospitable:${user_id}] Fetched ${properties.length} properties`)

        if (!properties.length) return {}

        const normalized = properties.map(hospitablePropertyToNormalized)

        try {
          return await upsertNormalizedProperties(org_id, PROVIDER, normalized)
        } catch (err) {
          logger.error(`[Hospitable:${user_id}] properties upsert failed: ${err instanceof Error ? err.message : String(err)}`)
          reportError(err, { site: 'inngest.hospitable-initial-sync.fetch-and-upsert-properties' })
          throw err
        }
      })

      // ── 3. Apply master checklist to new properties ───────────────────────
      const propertyIds = Object.values(propertyIdMap as Record<string, string>)

      // Seeded + fetched once for the whole sync run, not once per
      // property — applyMasterChecklistToProperty's default behavior is
      // to re-fetch the org's seed-check/mapping/room-templates/items on
      // every call, which is identical data for every property being
      // synced here. Only bothers with either step when there's actually
      // at least one property that needs it.
      let hospitableOrgRoomData: OrgRoomTemplateData | undefined

      if (propertyIds.length > 0) {
        await step.run('seed-room-templates', async () => {
          await seedDefaultRoomTemplatesIfNeeded(org_id)
        })

        hospitableOrgRoomData = await step.run('fetch-room-template-data', async () => {
          const supabase = createServiceClient({ system: 'inngest:initial-sync' })
          return fetchOrgRoomTemplateData(org_id, supabase)
        })
      }

      for (const propertyId of propertyIds) {
        await step.run(`apply-master-checklist-${propertyId}`, async () => {
          const supabase = createServiceClient({ system: 'inngest:initial-sync' })
          await applyMasterChecklistToProperty(propertyId, org_id, supabase, {
            orgRoomData: hospitableOrgRoomData,
            skipSeed:    true,
          })
        })
      }

      // ── 3b. Seed confirmed-present assets from amenity data ─────────────────
      // Creates bare-stub, active property_assets rows for washer/dryer/
      // dishwasher/microwave/refrigerator/oven_range/fire_extinguisher when
      // Hospitable's amenities confirm they're present — crew discovery
      // still runs normally to capture make/model/photo details later.
      await step.run('seed-asset-discovery-from-amenities', async () => {
        try {
          const { seeded, total } = await seedPresentAssetsFromAmenities(org_id, propertyIds)
          logger.info(`[Hospitable:${user_id}] Asset discovery seeded for ${seeded}/${total} properties`)
        } catch (err) {
          logger.error(`[Hospitable:${user_id}] asset discovery seed failed: ${err instanceof Error ? err.message : String(err)}`)
          reportError(err, { site: 'inngest.hospitable-initial-sync.seed-asset-discovery-from-amenities' })
          // Non-fatal — don't throw, don't block the sync
        }
      })

      // ── 3c. Mark absent optional assets from amenity data ───────────────────
      // Complements 3b: marks optional asset types (pool_pump, hot_tub, etc.)
      // as confirmed absent (is_na: true) when none of their trigger amenity
      // slugs are present — see OPTIONAL_ASSET_AMENITY_MAP for the caveat on
      // Hospitable slug coverage for these specific amenities.
      await step.run('seed-absent-optional-assets-from-amenities', async () => {
        try {
          const { seeded, total } = await seedAbsentOptionalAssetsFromAmenities(org_id, propertyIds)
          logger.info(`[Hospitable:${user_id}] Absent-optional-asset seeding: ${seeded}/${total} properties`)
        } catch (err) {
          logger.warn(`[Hospitable:${user_id}] absent-optional-asset seeding failed: ${err instanceof Error ? err.message : String(err)}`)
          reportError(err, { site: 'inngest.hospitable-initial-sync.seed-absent-optional-assets-from-amenities' })
          // Non-fatal — don't throw, don't block the sync
        }
      })

      // ── 4. Fetch teammates and upsert as crew members ──────────────────────
      // Ongoing changes (added/updated/removed teammates) are picked up by
      // hospTeammateSyncCron's daily resync — Hospitable has no teammate
      // webhook to react to incrementally.
      const teammateCount = await step.run('fetch-and-upsert-teammates', async () => {
        const teammates = await hospFetchTeammates(token)
        logger.info(`[Hospitable:${user_id}] Fetched ${teammates.length} teammates`)

        const rows = hospitableTeammatesToCrewRows(org_id, teammates)
        if (!rows.length) return 0

        const supabase = createServiceClient({ system: 'inngest:initial-sync' })

        const { error } = await supabase
          .from('crew_members')
          .upsert(rows, {
            onConflict:       'org_id,external_id,external_source',
            ignoreDuplicates: false,
          })

        if (error) {
          logger.error(`[Hospitable:${user_id}] crew_members upsert failed: ${error.message}`)
          throw new Error(`Teammates upsert failed: ${error.message}`)
        }

        logger.info(`[Hospitable:${user_id}] Upserted ${rows.length} crew members from teammates`)
        return rows.length
      })

      // ── 5. Reservations → bookings → revenue → turnovers ──────────────────
      //     Extracted to reservation-sync.ts so the daily reconcile cron runs
      //     the IDENTICAL pipeline rather than a copy that drifts. Step ids
      //     are unchanged from when this was inline here.
      //
      //     revenueMode 'all': on a re-run every eligible reservation re-fires
      //     booking/confirmed. That is deliberate — the post is idempotent, and
      //     firing broadly is what lets a manual resync REPAIR an org whose
      //     revenue post failed the first time.
      const { reservationCount } = await syncHospitableReservations({
        step,
        logger,
        token,
        orgId:           org_id,
        userId:          user_id,
        propertyIdMap,
        lookaheadMonths: INITIAL_SYNC_LOOKAHEAD_MONTHS,
        system:          'inngest:initial-sync',
        revenueMode:     'all',
      })

      // ── 7. Guidebook config sync ────────────────────────────────────────────
      // Mirrors the OwnerRez pattern: start the org's 30-day guidebook trial
      // if it doesn't already have one, auto-create blank guidebook configs
      // (with unique slugs) for any active property that lacks one, then
      // copy the WiFi/house-manual/access-instructions staged onto
      // `properties` above into the guidebook config — but only where the
      // PM hasn't already entered their own value.
      await step.run('create-guidebook-org-config', async () => {
        await ensureGuidebookConfiguration(org_id)
      })

      await step.run('create-guidebook-property-configs', async () => {
        try {
          await createGuidebookPropertyConfigsForProperties(org_id)
        } catch (err) {
          logger.error(`[Hospitable:${user_id}] guidebook config creation failed: ${err instanceof Error ? err.message : String(err)}`)
          reportError(err, { site: 'inngest.hospitable-initial-sync.create-guidebook-property-configs' })
          // Non-fatal — don't throw, don't block the sync
        }
      })

      await step.run('sync-guidebook-configs-from-property', async () => {
        await syncGuidebookConfigsFromProperty(org_id, PROVIDER)
        logger.info(`[Hospitable:${user_id}] Synced guidebook configs for org ${org_id}`)
      })

      // ── 8. Mark sync complete ─────────────────────────────────────────────
      await step.run('mark-complete', async () => {
        // The shared atomic merge, not a local read-then-update. There WAS a
        // local updateConnectionMeta() here doing exactly the read-modify-write
        // that 20260722130000 added this RPC to eliminate — and whose header
        // names this case: "concurrent sync runs for the same connection can
        // otherwise silently clobber each other's metadata writes". OwnerRez
        // already used the helper; Hospitable had its own copy.
        //
        // It also discarded the read's error, which was worse than the race:
        // `existingMeta` fell back to {} and the update then REPLACED the whole
        // metadata object with just the patch, dropping every other key.
        await mergeIntegrationConnectionMetadata({
          userId:     user_id,
          providerId: PROVIDER,
          patch: {
            last_sync_status: 'success',
            last_sync_error:  null,
            last_synced_at:   new Date().toISOString(),
            last_sync_count:  reservationCount,
            external_user_id,
          },
        })
      })

      logger.info(
        `[Hospitable:${user_id}] Initial sync complete — ` +
        `${Object.keys(propertyIdMap).length} properties, ${teammateCount} crew members, ${reservationCount} bookings`
      )

      return {
        properties:   Object.keys(propertyIdMap).length,
        crew_members: teammateCount,
        reservations: reservationCount,
      }
    } catch (err) {
      const msg         = err instanceof Error ? err.message : String(err)
      const friendlyMsg = translateSyncError(err, 'Hospitable')
      logger.error(`[Hospitable:${user_id}] initial sync failed: ${msg}`)
      reportError(err, { site: 'inngest.hospitable-initial-sync.mark-complete' })

      await step.run('handle-failure', async () => {
        // One atomic write, not a status update followed by a metadata merge.
        // Split across two statements, a crash between them left the connection
        // flipped to 'error' with metadata still claiming the last sync
        // succeeded — and the status write discarded its own result besides.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

