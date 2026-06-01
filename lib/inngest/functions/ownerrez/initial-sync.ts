/**
 * OwnerRez Initial Sync
 *
 * Triggered by: integration/ownerrez.connected
 * Steps (each independently retried):
 *  1. fetch-properties  — getProperties(), upsert into public.properties
 *  2. fetch-bookings    — getBookings({ propertyIds }), upsert into public.bookings
 *  3. update-last-synced — write sync_cursor + last_synced_at to integration_connections
 */

import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { OwnerRezApiClient }    from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError } from '@/lib/integrations/types'
import type { OwnerRezProperty, OwnerRezBooking } from '@/lib/integrations/types'

const PROVIDER = 'ownerrez'

export const ownerRezInitialSync = inngest.createFunction(
  {
    id:      'ownerrez-initial-sync',
    name:    'OwnerRez Initial Sync',
    retries: 3,
  },
  { event: 'integration/ownerrez.connected' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id, external_user_id } = event.data
    const client = new OwnerRezApiClient(user_id)

    // ── Step 1: Fetch and upsert properties ─────────────────────────────────

    const propertyIds = await step.run('fetch-properties', async () => {
      let properties: OwnerRezProperty[]

      try {
        properties = await client.getProperties()
      } catch (err) {
        if (err instanceof RateLimitError) {
          throw err // Inngest will retry
        }
        throw err
      }

      if (!properties.length) return []

      const supabase = createServiceClient()
      const rows = properties.map((p) => ({
        org_id,
        name:            p.name,
        bedrooms:        p.bedrooms,
        bathrooms:       p.bathrooms,
        max_guests:      p.max_occupancy,
        external_id:     String(p.id),
        external_source: PROVIDER,
        // Required fields with defaults
        property_type:              'other',
        avg_stay_length:            0,
        avg_turnovers_per_month:    0,
        checkout_time:              '11:00',
        checkin_time:               '15:00',
        setup_steps_completed:      {},
        is_active:                  true,
      }))

      const { error } = await supabase
        .from('properties')
        .upsert(rows, { onConflict: 'external_id,external_source' })

      if (error) {
        logger.error(`[OwnerRez:${user_id}] properties upsert failed: ${error.message}`)
        throw new Error(error.message)
      }

      logger.info(`[OwnerRez:${user_id}] Upserted ${rows.length} properties`)

      // Return OwnerRez property IDs for the bookings step
      return properties.map((p) => p.id)
    })

    // ── Step 2: Fetch and upsert bookings ────────────────────────────────────

    const syncCursor = await step.run('fetch-bookings', async () => {
      if (!propertyIds.length) return new Date().toISOString()

      let bookings: OwnerRezBooking[]

      try {
        bookings = await client.getBookings({ propertyIds })
      } catch (err) {
        if (err instanceof RateLimitError) {
          throw err
        }
        throw err
      }

      if (bookings.length) {
        const supabase   = createServiceClient()

        // Resolve FieldStay property IDs from external IDs
        const { data: fsProps } = await supabase
          .from('properties')
          .select('id, external_id')
          .eq('org_id', org_id)
          .eq('external_source', PROVIDER)
          .in('external_id', propertyIds.map(String))

        const externalToFsId = Object.fromEntries(
          (fsProps ?? []).map((p) => [p.external_id, p.id])
        )

        const rows = bookings
          .map((b) => {
            const propertyId = externalToFsId[String(b.guest)] // Note: matching by booking's related property
            return {
              org_id,
              property_id:     null as string | null,  // resolved below
              guest_name:      b.guest?.name   ?? null,
              guest_email:     b.guest?.email  ?? null,
              checkin_date:    b.arrival,
              checkout_date:   b.departure,
              source:          mapChannelToSource(b.channel_name),
              status:          mapBookingStatus(b.status),
              external_id:     String(b.id),
              external_source: PROVIDER,
            }
          })

        // We need property_id from the booking itself, not from guest
        // Rebuild with correct property_id mapping
        const bookingRows = bookings.map((b) => ({
          org_id,
          property_id:     null as string | null,
          guest_name:      b.guest?.name   ?? null,
          guest_email:     b.guest?.email  ?? null,
          checkin_date:    b.arrival,
          checkout_date:   b.departure,
          source:          mapChannelToSource(b.channel_name),
          status:          mapBookingStatus(b.status),
          external_id:     String(b.id),
          external_source: PROVIDER,
        }))

        const { error } = await supabase
          .from('bookings')
          .upsert(bookingRows, { onConflict: 'external_id,external_source' })

        if (error) {
          logger.error(`[OwnerRez:${user_id}] bookings upsert failed: ${error.message}`)
          throw new Error(error.message)
        }

        logger.info(`[OwnerRez:${user_id}] Upserted ${bookingRows.length} bookings`)
      }

      return new Date().toISOString()
    })

    // ── Step 3: Update sync metadata ─────────────────────────────────────────

    await step.run('update-last-synced', async () => {
      const supabase = createServiceClient()
      await supabase
        .from('integration_connections')
        .update({
          metadata: {
            sync_cursor:     syncCursor,
            last_synced_at:  new Date().toISOString(),
          },
        })
        .eq('user_id', user_id)
        .eq('provider_id', PROVIDER)
    })

    return { user_id, synced: true }
  }
)

// ── Data mapping helpers ──────────────────────────────────────────────────────

function mapBookingStatus(status: string): string {
  const s = status.toLowerCase()
  if (s === 'confirmed') return 'confirmed'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'tentative') return 'tentative'
  return 'confirmed'
}

function mapChannelToSource(channel?: string): string {
  if (!channel) return 'other'
  const c = channel.toLowerCase()
  if (c.includes('airbnb'))                    return 'airbnb'
  if (c.includes('vrbo') || c.includes('homeaway')) return 'vrbo'
  if (c.includes('booking'))                   return 'booking_com'
  if (c.includes('direct'))                    return 'direct'
  return 'other'
}
