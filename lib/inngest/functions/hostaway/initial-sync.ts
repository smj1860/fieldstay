/**
 * DISABLED — not ready for launch (product decision, 2026-07-25). This
 * function is intact and functional; it is simply unregistered so it can
 * never run:
 *   - Not registered in app/api/inngest/route.ts's serve() functions array
 *     (the `hostawayInitialSync` import + array entry are commented out there)
 *   - Its provider adapter (lib/integrations/providers/hostaway.ts) is not
 *     registered in lib/integrations/registry.ts either
 *   - Nothing sends the triggering event — connectWithApiKey() in
 *     app/(dashboard)/settings/integrations/actions.ts (the only place that
 *     used to send it) has its Hostaway credential-exchange path commented out
 * To re-enable: uncomment the registry entry, the Inngest route
 * registration, and the connect entry points (see hostaway.ts's top-of-file
 * comment for the full list).
 *
 * Hostaway Initial Sync
 *
 * Triggered by: integration/hostaway.sync.requested
 * Steps (each independently retried):
 *  1. read-token          — pull the Bearer token from Vault
 *  2. fetch-listings       — hostawayFetchListings(), upsert into public.properties
 *  3. fetch-reservations   — hostawayFetchReservations(), upsert into public.bookings
 *  4. generate-turnovers   — generateTurnoversForProperty() per affected property
 *  5. mark-complete        — write last_sync_status to integration_connections
 */

import { asJsonObject } from '@/lib/json'
import type { Json } from '@/types/database'
import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { readIntegrationToken } from '@/lib/integrations/vault'
import {
  hostawayFetchListings,
  hostawayFetchReservations,
  type HostawayReservation,
} from '@/lib/integrations/providers/hostaway'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { unmappedBookingStatus }        from '@/lib/bookings/normalize'

import { reportError } from '@/lib/observability/report-error'
import { unwrap, unwrapList } from '@/lib/supabase/unwrap'
const PROVIDER = 'hostaway'

export const hostawayInitialSync = inngest.createFunction(
  {
    id:      'hostaway-initial-sync',
    name:    'Hostaway: Initial Sync',
    retries: 2,
    // One sync per org at a time — avoids racing the same properties/bookings rows
    concurrency: { limit: 1, key: 'event.data.org_id' },
  },
  { event: 'integration/hostaway.sync.requested' },
  async ({ event, step, logger }) => {
    const { user_id, org_id, since } = event.data

    try {
      // ── 1. Read token from Vault ──────────────────────────────────────
      const token = await step.run('read-token', async () => {
        const t = await readIntegrationToken(user_id, PROVIDER)
        if (!t) throw new Error('No Hostaway token found — reconnect required')
        return t
      })

      // ── 2. Fetch listings, upsert properties ──────────────────────────
      const propertyIdMap = await step.run('fetch-and-upsert-properties', async () => {
        const listings = await hostawayFetchListings(token)
        logger.info(`[Hostaway:${user_id}] Fetched ${listings.length} listings`)

        const supabase = createServiceClient({ system: 'inngest:initial-sync' })
        const idMap: Record<number, string> = {}  // hostaway listing id → fieldstay property uuid

        if (listings.length) {
          const rows = listings.map((listing) => ({
            org_id,
            name:                    listing.externalListingName ?? listing.name,
            address:                 listing.address ?? null,
            city:                    listing.city ?? null,
            state:                   listing.state ?? null,
            zip:                     listing.zipcode ?? null,
            lat:                     listing.lat ?? null,
            lng:                     listing.lng ?? null,
            bedrooms:                listing.bedrooms ?? 1,
            bathrooms:               listing.bathrooms ?? 1,
            max_guests:              listing.maxGuests ?? 2,
            external_id:             String(listing.id),
            external_source:         PROVIDER,
            property_type:           'other' as const,
            avg_stay_length:         0,
            avg_turnovers_per_month: 0,
            checkout_time:           '11:00',
            checkin_time:            '15:00',
            setup_steps_completed:   {},
            is_active:               true,
          }))

          const { error } = await supabase
            .from('properties')
            .upsert(rows, { onConflict: 'org_id,external_id,external_source' })

          if (error) {
            logger.error(`[Hostaway:${user_id}] properties upsert failed: ${error.message}`)
            throw new Error(error.message)
          }

          const fsPropsRes = await supabase
            .from('properties')
            .select('id, external_id')
            .eq('org_id', org_id)
            .eq('external_source', PROVIDER)
            .in('external_id', listings.map((l) => String(l.id)))
          const fsProps = unwrapList(fsPropsRes, {
            site:  'inngest.hostaway-initial-sync.fetch-and-upsert-properties',
            orgId: org_id,
          })

          // O(1) lookups instead of an O(n²) .find() inside the loop
          const listingById = new Map(listings.map((l) => [String(l.id), l]))

          for (const p of fsProps) {
            // properties.external_id is nullable — a property never synced
            // from Hostaway has nothing to look up.
            if (p.external_id === null) continue
            const hostawayId = listingById.get(p.external_id)?.id
            if (hostawayId !== undefined) idMap[hostawayId] = p.id
          }
        }

        logger.info(`[Hostaway:${user_id}] Upserted ${Object.keys(idMap).length} properties`)

        await updateConnectionMetadata(user_id, { properties_found: listings.length })

        return idMap
      })

      // ── 3. Fetch reservations, upsert bookings ────────────────────────
      const { reservationCount, affectedPropertyIds } = await step.run(
        'fetch-and-upsert-bookings',
        async () => {
          const reservations = await hostawayFetchReservations(token, since)
          logger.info(`[Hostaway:${user_id}] Fetched ${reservations.length} reservations`)

          const supabase = createServiceClient({ system: 'inngest:initial-sync' })
          const touched   = new Set<string>()
          const bookingRows = reservations
            .map((res: HostawayReservation) => {
              const propertyId = propertyIdMap[res.listingId]
              if (!propertyId) return null  // skip if we don't have this property
              touched.add(propertyId)
              return {
                org_id,
                property_id:     propertyId,
                external_id:     String(res.id),
                external_source: PROVIDER,
                guest_name:      res.guestName ?? null,
                guest_email:     res.guestEmail ?? null,
                checkin_date:    res.arrivalDate,
                checkout_date:   res.departureDate,
                status:          mapHostawayStatus(res.status),
                source:          mapHostawayChannel(res.channelName),
                // ⚠️ Unconfirmed: HostawayReservation.status ('new' |
                // 'modified' | 'cancelled' | 'confirmed' | 'inquiry' |
                // 'tentative') has no documented blocked-time value —
                // hardcoded false until Hostaway's docs or a live payload
                // show how manually-blocked calendar time surfaces here (if
                // it does at all via this endpoint).
                is_block:        false,
              }
            })
            .filter((row): row is NonNullable<typeof row> => row !== null)

          if (bookingRows.length) {
            const { error } = await supabase
              .from('bookings')
              .upsert(bookingRows, { onConflict: 'org_id,external_id,external_source' })

            if (error) {
              logger.error(`[Hostaway:${user_id}] bookings upsert failed: ${error.message}`)
              throw new Error(error.message)
            }
          }

          logger.info(`[Hostaway:${user_id}] Upserted ${bookingRows.length} bookings`)

          await updateConnectionMetadata(user_id, { bookings_found: reservations.length })

          return { reservationCount: reservations.length, affectedPropertyIds: [...touched] }
        }
      )

      // ── 4. Generate turnovers for affected properties ────────────────
      const newTurnoverIds = await step.run('generate-turnovers', async () => {
        if (!affectedPropertyIds.length) return []
        const supabase = createServiceClient({ system: 'inngest:initial-sync' })
        const ids: string[] = []
        for (const propertyId of affectedPropertyIds) {
          try {
            const newIds = await generateTurnoversForProperty(propertyId, org_id, supabase)
            ids.push(...newIds)
          } catch (err) {
            logger.error(`[Hostaway:${user_id}] Turnover generation failed for ${propertyId}: ${err}`)
            reportError(err, { site: 'inngest.hostaway-initial-sync.generate-turnovers' })
            // Don't let one property's failure block the others
          }
        }
        return ids
      })

      if (newTurnoverIds.length > 0) {
        const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
        const supabase = createServiceClient({ system: 'inngest:initial-sync' })
        return fetchTurnoverCreatedEvents(supabase, newTurnoverIds, org_id)
      })

        if (turnoverEvents.length > 0) {
          await step.sendEvent('fire-turnover-created-events', turnoverEvents)
        }
      }

      // ── 5. Mark sync as complete ──────────────────────────────────────
      await step.run('mark-complete', async () => {
        await updateConnectionMetadata(user_id, {
          last_sync_status: 'success',
          last_sync_error:  null,
          last_synced_at:   new Date().toISOString(),
          last_sync_count:  reservationCount,
        })
      })

      return {
        properties:    Object.keys(propertyIdMap).length,
        reservations:  reservationCount,
        turnovers_for: affectedPropertyIds.length,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[Hostaway:${user_id}] initial sync failed: ${msg}`)
      reportError(err, { site: 'inngest.hostaway-initial-sync.mark-complete' })

      await step.run('handle-sync-failure', async () => {
        const supabase = createServiceClient({ system: 'inngest:initial-sync' })
        const { error: statusUpdateError } = await supabase
          .from('integration_connections')
          .update({ status: 'error' })
          .eq('user_id', user_id)
          .eq('provider_id', PROVIDER)

        if (statusUpdateError) {
          logger.error(`[Hostaway:${user_id}] failed to mark connection status error: ${statusUpdateError.message}`)
          reportError(statusUpdateError, { site: 'inngest.hostaway-initial-sync.handle-sync-failure', orgId: org_id })
        }

        await updateConnectionMetadata(user_id, {
          last_sync_status: 'error',
          last_sync_error:  msg,
          last_synced_at:   new Date().toISOString(),
        })
      })

      throw err
    }
  }
)

// ── Helpers ────────────────────────────────────────────────────────────────

async function updateConnectionMetadata(
  userId: string,
  patch:  Record<string, Json>
): Promise<void> {
  const supabase = createServiceClient({ system: 'inngest:initial-sync' })
  const existingRes = await supabase
    .from('integration_connections')
    .select('metadata')
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()
  const existing = unwrap(existingRes, {
    site:  'inngest.hostaway-initial-sync.updateConnectionMetadata',
    extra: { user_id: userId },
  })

  const existingMeta = asJsonObject(existing?.metadata) ?? {}

  const { error } = await supabase
    .from('integration_connections')
    .update({ metadata: { ...existingMeta, ...patch } })
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)

  if (error) {
    console.error(`[Hostaway] connection metadata update failed for ${userId}:`, error)
    reportError(error, { site: 'inngest.hostaway-initial-sync.updateConnectionMetadata', extra: { user_id: userId } })
    throw new Error(error.message)
  }
}

function mapHostawayStatus(status: string): 'confirmed' | 'tentative' | 'cancelled' {
  switch (status) {
    case 'confirmed':
    case 'modified':   return 'confirmed'
    case 'tentative':
    case 'new':
    case 'inquiry':     return 'tentative'
    case 'cancelled':   return 'cancelled'
    default:            return unmappedBookingStatus('hostaway', status)
  }
}

function mapHostawayChannel(channel?: string): 'airbnb' | 'vrbo' | 'booking_com' | 'direct' | 'other' {
  if (!channel) return 'other'
  const c = channel.toLowerCase()
  if (c.includes('airbnb'))                          return 'airbnb'
  if (c.includes('vrbo') || c.includes('homeaway'))  return 'vrbo'
  if (c.includes('booking'))                         return 'booking_com'
  if (c.includes('direct'))                          return 'direct'
  return 'other'
}
