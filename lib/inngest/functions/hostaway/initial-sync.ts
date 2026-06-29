/**
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

import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { readIntegrationToken } from '@/lib/integrations/vault'
import {
  hostawayFetchListings,
  hostawayFetchReservations,
  type HostawayReservation,
} from '@/lib/integrations/providers/hostaway'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'

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

        const supabase = createServiceClient()
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
            .upsert(rows, { onConflict: 'external_id,external_source' })

          if (error) {
            logger.error(`[Hostaway:${user_id}] properties upsert failed: ${error.message}`)
            throw new Error(error.message)
          }

          const { data: fsProps } = await supabase
            .from('properties')
            .select('id, external_id')
            .eq('org_id', org_id)
            .eq('external_source', PROVIDER)
            .in('external_id', listings.map((l) => String(l.id)))

          // O(1) lookups instead of an O(n²) .find() inside the loop
          const listingById = new Map(listings.map((l) => [String(l.id), l]))

          for (const p of fsProps ?? []) {
            const hostawayId = listingById.get(p.external_id)?.id
            if (hostawayId != null) idMap[hostawayId] = p.id
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

          const supabase = createServiceClient()
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
                is_block:        false,
              }
            })
            .filter((row): row is NonNullable<typeof row> => row !== null)

          if (bookingRows.length) {
            const { error } = await supabase
              .from('bookings')
              .upsert(bookingRows, { onConflict: 'external_id,external_source' })

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
        const supabase = createServiceClient()
        const ids: string[] = []
        for (const propertyId of affectedPropertyIds) {
          try {
            const newIds = await generateTurnoversForProperty(propertyId, org_id, supabase)
            ids.push(...newIds)
          } catch (err) {
            logger.error(`[Hostaway:${user_id}] Turnover generation failed for ${propertyId}: ${err}`)
            // Don't let one property's failure block the others
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

          return (turnovers as TRow[] ?? []).map((t) => ({
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

      await step.run('handle-sync-failure', async () => {
        const supabase = createServiceClient()
        await supabase
          .from('integration_connections')
          .update({ status: 'error' })
          .eq('user_id', user_id)
          .eq('provider_id', PROVIDER)

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

function mapHostawayStatus(status: string): 'confirmed' | 'tentative' | 'cancelled' {
  switch (status) {
    case 'confirmed':
    case 'modified':   return 'confirmed'
    case 'tentative':
    case 'new':
    case 'inquiry':     return 'tentative'
    case 'cancelled':   return 'cancelled'
    default:            return 'confirmed'
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
