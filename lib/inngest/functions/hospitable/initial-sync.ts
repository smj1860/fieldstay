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
import {
  hospFetchProperties,
  hospFetchReservations,
  hospFetchTeammates,
  mapHospitableTeammateRole,
  resolveHospitableTeammateName,
  resolveHospitableTimezone,
  mapHospitableStatus,
  mapHospitableChannel,
  extractHospitableTime,
  normalizeHospitableAmenities,
  type HospitableReservation,
  type HospitableTeammate,
} from '@/lib/integrations/providers/hospitable'
import { applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'
import { generateTurnoversForProperty }   from '@/lib/turnovers/generator'
import {
  ensureGuidebookConfiguration,
  createGuidebookPropertyConfigsForProperties,
  syncGuidebookConfigsFromProperty,
} from '@/lib/guidebook/sync'
import { seedPresentAssetsFromAmenities } from '@/lib/asset-discovery/seed-from-amenities'

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

        const supabase = createServiceClient()
        const idMap: Record<string, string> = {}  // hospitable UUID → fieldstay UUID

        if (!properties.length) return idMap

        const rows = properties.map((prop) => {
          const addr = prop.address
          const addressParts = [addr.number, addr.street].filter(Boolean)
          const addressStr   = addressParts.join(' ') || null

          const bedroomCount = prop.capacity.bedrooms
            ?? prop.room_details.filter((r) => r.type === 'bedroom').length
            ?? 1

          return {
            org_id,
            name:                    prop.public_name || prop.name,
            address:                 addressStr,
            city:                    addr.city ?? null,
            state:                   addr.state ?? null,
            zip:                     addr.postcode ?? null,
            bedrooms:                bedroomCount,
            bathrooms:               prop.capacity.bathrooms ?? 1,   // ✅ confirmed live via include=details
            max_guests:              prop.capacity.max ?? 2,
            external_id:             prop.id,
            external_source:         PROVIDER,
            property_type:           'other' as const,
            avg_stay_length:         0,
            avg_turnovers_per_month: 0,
            checkin_time:            prop.checkin  ?? '15:00',
            checkout_time:           prop.checkout ?? '11:00',
            // prop.timezone is a UTC offset (e.g. "-0500"), not an IANA identifier.
            // Derive from property state for DST-correct Intl compatibility.
            timezone:                resolveHospitableTimezone(prop.timezone, addr.state),
            setup_steps_completed:   {} as Record<string, boolean>,
            is_active:               true,

            // ── Staging fields for the guidebook sync — mirrors the OwnerRez
            // pattern: raw provider data lands here first, then
            // syncGuidebookConfigsFromProperty() copies it into
            // guidebook_property_configs only where the PM hasn't already
            // entered their own value. wifi_password/house_manual are
            // credentials/free-text that may embed a credential — this
            // table already has the exact same columns for OwnerRez.
            wifi_name:               prop.details?.wifi_name       || null,
            wifi_password:           prop.details?.wifi_password   || null,
            access_instructions:     prop.details?.guest_access    || null,
            house_manual:            prop.details?.house_manual    || null,
            amenities:               normalizeHospitableAmenities(prop.amenities),
            smoking_allowed:         prop.house_rules?.smoking_allowed ?? null,
            pets_allowed:            prop.house_rules?.pets_allowed    ?? null,
            events_allowed:          prop.house_rules?.events_allowed  ?? null,
          }
        })

        const { error: upsertError } = await supabase
          .from('properties')
          .upsert(rows, { onConflict: 'external_id,external_source' })

        if (upsertError) {
          logger.error(`[Hospitable:${user_id}] properties upsert failed: ${upsertError.message}`)
          throw new Error(`Properties upsert failed: ${upsertError.message}`)
        }

        const { data: upserted } = await supabase
          .from('properties')
          .select('id, external_id')
          .eq('org_id', org_id)
          .eq('external_source', PROVIDER)
          .in('external_id', properties.map((p) => p.id))

        for (const row of upserted ?? []) {
          idMap[row.external_id] = row.id
        }

        return idMap
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

      // ── 4. Fetch teammates and upsert as crew members ──────────────────────
      const teammateCount = await step.run('fetch-and-upsert-teammates', async () => {
        const teammates = await hospFetchTeammates(token)
        logger.info(`[Hospitable:${user_id}] Fetched ${teammates.length} teammates`)

        if (!teammates.length) return 0

        const resolved = teammates
          .map((t) => ({ t, name: resolveHospitableTeammateName(t) }))
          .filter((entry): entry is { t: HospitableTeammate; name: string } =>
            entry.name !== null && entry.name.trim().length > 0
          )

        if (!resolved.length) return 0

        const rows = resolved.map(({ t, name }) => {
          const role      = mapHospitableTeammateRole(t.services)
          const specialty = t.services.length
            ? t.services.map((s) => s.label).join(', ')
            : null

          return {
            org_id,
            name,
            email:            t.email        ?? null,
            phone:            t.phone_number ?? null,
            role,
            is_active:        true,
            specialty,
            // reliability_score / capacity_score are 0–1 scale, NOT NULL —
            // 1.0 matches the column DEFAULT and is a neutral starting score
            // for auto-assign-turnover's scoring algorithm.
            reliability_score: 1.0,
            capacity_score:    1.0,
            external_id:      t.id,
            external_source:  PROVIDER,
          }
        })

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
      const reservationCount = await step.run('fetch-and-upsert-reservations', async () => {
        const hospPropertyIds = Object.keys(propertyIdMap)
        if (!hospPropertyIds.length) return 0
        const reservations = await hospFetchReservations(token, undefined, hospPropertyIds)

        logger.info(`[Hospitable:${user_id}] Fetched ${reservations.length} reservations`)

        const supabase = createServiceClient()
        let count = 0

        const bookingRows = reservations
          .map((res: HospitableReservation) => {
            // Confirmed from the official Hospitable webhook spec: 'properties'
            // is an array[Property], not a singular 'property' object.
            const propertyExternalId = res.properties?.[0]?.id ?? null
            const propertyId         = propertyExternalId
              ? propertyIdMap[propertyExternalId]
              : null

            if (!propertyId) {
              logger.warn(
                `[Hospitable:${user_id}] Skipping reservation ${res.id} — ` +
                `no FieldStay property found for Hospitable property ` +
                `${propertyExternalId ?? 'unknown'}`
              )
              return null
            }

            const status = mapHospitableStatus(res.reservation_status.current.category)

            // res.guest (singular) = GuestInfo, only present when include=guest.
            // res.guests (plural)  = GuestCounts (total/adult_count/etc) — not name data.
            const guest     = res.guest ?? null
            const guestName = guest
              ? [guest.first_name, guest.last_name].filter(Boolean).join(' ') || null
              : null

            return {
              org_id,
              property_id:     propertyId,
              external_id:     res.id,
              external_source: PROVIDER,

              // arrival_date / departure_date are ISO datetimes at midnight
              checkin_date:    res.arrival_date?.split('T')[0]   ?? null,
              checkout_date:   res.departure_date?.split('T')[0] ?? null,

              // check_in / check_out are ISO datetimes with the actual time of day
              checkin_time:    extractHospitableTime(res.check_in,  '15:00'),
              checkout_time:   extractHospitableTime(res.check_out, '11:00'),

              status,
              guest_name: guestName,
              source:     mapHospitableChannel(res.platform),
              is_block:   false,
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

        return count
      })

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
      const msg = err instanceof Error ? err.message : String(err)
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
          last_sync_error:  msg,
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
