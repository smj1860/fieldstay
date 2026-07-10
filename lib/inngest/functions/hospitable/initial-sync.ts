// lib/inngest/functions/hospitable/initial-sync.ts
// ============================================================
// Triggered by: integration/hospitable.connected
// Steps:
//  1. read-token              — pull Bearer token from Vault
//  2. fetch-and-upsert-props  — hospFetchProperties → upsert to properties
//  3. apply-master-checklist  — applyMasterChecklistToProperty per new property
//  3b. seed-asset-discovery-from-amenities — seedPresentAssetsFromAmenities per confirmed amenity
//  4. fetch-and-upsert-teammates — hospFetchTeammates → upsert to crew_members
//  5. fetch-and-upsert-res    — hospFetchReservations → upsert to bookings
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
  hospFetchReservations,
  hospFetchTeammates,
  hospitablePropertyToNormalized,
  hospitableReservationToNormalized,
  hospitableTeammatesToCrewRows,
} from '@/lib/integrations/providers/hospitable'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import { applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'
import { generateTurnoversForProperty }   from '@/lib/turnovers/generator'
import {
  ensureGuidebookConfiguration,
  createGuidebookPropertyConfigsForProperties,
  syncGuidebookConfigsFromProperty,
} from '@/lib/guidebook/sync'
import {
  seedPresentAssetsFromAmenities,
  seedAbsentOptionalAssetsFromAmenities,
} from '@/lib/asset-discovery/seed-from-amenities'

const PROVIDER = 'hospitable'

export const hospInitialSync = inngest.createFunction(
  {
    id:      'hospitable-initial-sync',
    name:    'Hospitable: Initial Sync',
    retries: 2,
    concurrency: { limit: 1, key: 'event.data.org_id' },
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
          throw err
        }
      })

      // ── 3. Apply master checklist to new properties ───────────────────────
      const propertyIds = Object.values(propertyIdMap as Record<string, string>)

      for (const propertyId of propertyIds) {
        await step.run(`apply-master-checklist-${propertyId}`, async () => {
          const supabase = createServiceClient()
          await applyMasterChecklistToProperty(propertyId, org_id, supabase)
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

        const supabase = createServiceClient()

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

      // ── 5. Fetch reservations and upsert bookings ─────────────────────────
      const { reservationCount, revenueEligibleExternalIds } = await step.run('fetch-and-upsert-reservations', async () => {
        const hospPropertyIds = Object.keys(propertyIdMap)
        if (!hospPropertyIds.length) return { reservationCount: 0, revenueEligibleExternalIds: [] as string[] }
        const reservations = await hospFetchReservations(token, undefined, hospPropertyIds)

        logger.info(`[Hospitable:${user_id}] Fetched ${reservations.length} reservations`)

        const supabase = createServiceClient()
        let count = 0
        const revenueEligibleExternalIds: string[] = []

        const bookingRows = reservations
          .map((res) => {
            const normalized = hospitableReservationToNormalized(res)
            const propertyId = normalized.property_external_id
              ? propertyIdMap[normalized.property_external_id]
              : null

            if (!propertyId) {
              logger.warn(
                `[Hospitable:${user_id}] Skipping reservation ${res.id} — ` +
                `no FieldStay property found for Hospitable property ` +
                `${normalized.property_external_id ?? 'unknown'}`
              )
              return null
            }

            // Only a confirmed, paying-guest stay should post revenue — not
            // a tentative request, a cancellation, or the owner's own stay.
            if (normalized.status === 'confirmed' && normalized.stay_type === 'guest_stay') {
              revenueEligibleExternalIds.push(normalized.external_id)
            }

            return {
              org_id,
              property_id:          propertyId,
              external_source:      PROVIDER,
              external_id:          normalized.external_id,
              checkin_date:         normalized.checkin_date,
              checkout_date:        normalized.checkout_date,
              checkin_time:         normalized.checkin_time,
              checkout_time:        normalized.checkout_time,
              status:               normalized.status,
              guest_name:           normalized.guest_name,
              guest_email:          normalized.guest_email,
              source:               normalized.source,
              is_block:             normalized.is_block,
              stay_type:            normalized.stay_type,
              actual_total_amount:  normalized.actual_total_amount,
            }
          })
          .filter((row): row is NonNullable<typeof row> => row !== null)

        if (bookingRows.length) {
          const { error } = await supabase
            .from('bookings')
            .upsert(bookingRows, { onConflict: 'external_id,external_source' })

          if (error) {
            logger.error(`[Hospitable:${user_id}] bookings upsert failed: ${error.message}`)
            throw new Error(`Bookings upsert failed: ${error.message}`)
          }
          count = bookingRows.length
        }

        return { reservationCount: count, revenueEligibleExternalIds }
      })

      // ── 5b. Post revenue for confirmed guest stays ────────────────────────
      // The first producer booking/confirmed has ever had — see
      // lib/inngest/functions/booking-events.ts. handleBookingConfirmed's
      // own upsert (onConflict source_reference_id,source DO NOTHING)
      // makes a repeat post for the same booking a no-op, so re-running
      // initial sync can't double-post.
      if (revenueEligibleExternalIds.length > 0) {
        const revenueEvents = await step.run('fetch-bookings-for-revenue', async () => {
          const supabase = createServiceClient()
          const { data: rows } = await supabase
            .from('bookings')
            .select('id, property_id, actual_total_amount')
            .eq('org_id', org_id)
            .eq('external_source', PROVIDER)
            .in('external_id', revenueEligibleExternalIds)

          return (rows ?? []).map((b) => ({
            name: 'booking/confirmed' as const,
            data: {
              booking_id:          b.id as string,
              property_id:         b.property_id as string,
              org_id,
              source:              'hospitable' as const,
              actual_total_amount: b.actual_total_amount as number | null,
            },
          }))
        })

        if (revenueEvents.length > 0) {
          await step.sendEvent('fire-booking-confirmed-events', revenueEvents)
        }
      }

      // ── 6. Generate turnovers for each property that received bookings ─────
      const affectedPropertyIds = [...new Set(Object.values(propertyIdMap as Record<string, string>))]

      const newTurnoverIds = await step.run('generate-turnovers', async () => {
        if (!affectedPropertyIds.length) return []
        const supabase = createServiceClient()
        const ids: string[] = []
        for (const propertyId of affectedPropertyIds) {
          try {
            const newIds = await generateTurnoversForProperty(propertyId, org_id, supabase)
            ids.push(...newIds)
          } catch (err) {
            logger.error(`[Hospitable:${user_id}] Turnover generation failed for ${propertyId}: ${err}`)
          }
        }
        return ids
      })

      if (newTurnoverIds.length > 0) {
        const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
          const supabase = createServiceClient()
          type TRow = { id: string; property_id: string; checkout_datetime: string; checkin_datetime: string; window_minutes: number | null }
          const { data: turnovers } = await supabase
            .from('turnovers')
            .select('id, property_id, checkout_datetime, checkin_datetime, window_minutes')
            .in('id', newTurnoverIds)

          return ((turnovers as TRow[]) ?? []).map((t) => ({
            name: 'turnover/created' as const,
            data: {
              turnover_id:       t.id,
              property_id:       t.property_id,
              org_id,
              checkout_datetime: t.checkout_datetime,
              checkin_datetime:  t.checkin_datetime,
              window_minutes:    t.window_minutes ?? 0,
            },
          }))
        })

        if (turnoverEvents.length > 0) {
          await step.sendEvent('fire-turnover-events', turnoverEvents)
        }
      }

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
          // Non-fatal — don't throw, don't block the sync
        }
      })

      await step.run('sync-guidebook-configs-from-property', async () => {
        await syncGuidebookConfigsFromProperty(org_id, PROVIDER)
        logger.info(`[Hospitable:${user_id}] Synced guidebook configs for org ${org_id}`)
      })

      // ── 8. Mark sync complete ─────────────────────────────────────────────
      await step.run('mark-complete', async () => {
        await updateConnectionMeta(user_id, {
          last_sync_status: 'success',
          last_sync_error:  null,
          last_synced_at:   new Date().toISOString(),
          last_sync_count:  reservationCount,
          external_user_id,
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

      await step.run('handle-failure', async () => {
        const supabase = createServiceClient()
        await supabase
          .from('integration_connections')
          .update({ status: 'error' })
          .eq('user_id', user_id)
          .eq('provider_id', PROVIDER)

        await updateConnectionMeta(user_id, {
          last_sync_status: 'error',
          last_sync_error:  friendlyMsg,
          last_synced_at:   new Date().toISOString(),
        })
      })

      throw err
    }
  }
)

// ── Helpers ───────────────────────────────────────────────────────────────────

async function updateConnectionMeta(
  userId: string,
  patch:  Record<string, unknown>
): Promise<void> {
  const supabase = createServiceClient()
  const { data: existing } = await supabase
    .from('integration_connections')
    .select('metadata')
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {}

  await supabase
    .from('integration_connections')
    .update({ metadata: { ...existingMeta, ...patch } })
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
}
