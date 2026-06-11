/**
 * OwnerRez Initial Sync
 *
 * Triggered by: integration/ownerrez.connected
 * Steps (each independently retried):
 *  1. fetch-properties      — getProperties(), upsert into public.properties
 *  1b. patch-property-fields — fill null bedrooms/bathrooms/sqft from OwnerRez data
 *  2. fetch-bookings         — getBookings(), upsert into public.bookings
 *  3. update-last-synced     — write sync_cursor + last_synced_at to integration_connections
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
    const workflowId = crypto.randomUUID()
    logger.info('ownerrez-initial-sync start', { workflowId, user_id, org_id })

    const client = new OwnerRezApiClient(user_id)

    // ── Step 1: Fetch and upsert properties ─────────────────────────────────

    const fetchPropsResult = await step.run('fetch-properties', async () => {
      let properties: OwnerRezProperty[]

      try {
        properties = await client.getProperties()
      } catch (err) {
        if (err instanceof RateLimitError) {
          throw err // Inngest will retry
        }
        throw err
      }

      if (!properties.length) return { ids: [] as number[], patchData: [] as typeof patchData }

      const patchData = properties.map((p) => ({
        externalId: String(p.id),
        bedrooms:   p.bedrooms,
        bathrooms:  p.bathrooms,
        sqft:       p.sqft ?? p.square_feet ?? p.size ?? null,
      }))

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

      return { ids: properties.map((p) => p.id), patchData }
    })

    // ── Step 1b: Patch null property fields from OwnerRez data ───────────────
    // Only fills fields that are currently NULL — never overwrites PM-entered data

    await step.run('patch-property-fields', async () => {
      if (!fetchPropsResult.patchData.length) return

      const supabase    = createServiceClient()
      const externalIds = fetchPropsResult.patchData.map((p) => p.externalId)

      const { data: existingProps } = await supabase
        .from('properties')
        .select('id, external_id, bedrooms, bathrooms, square_footage')
        .eq('org_id', org_id)
        .eq('external_source', PROVIDER)
        .in('external_id', externalIds)

      if (!existingProps?.length) return

      // MEDIUM-2: collect patch failures rather than silently swallowing them
      const failures: string[] = []

      for (const existing of existingProps) {
        const orData = fetchPropsResult.patchData.find((p) => p.externalId === existing.external_id)
        if (!orData) continue

        const patch: Record<string, unknown> = {}

        if (orData.bedrooms  != null && !existing.bedrooms)
          patch.bedrooms = orData.bedrooms

        if (orData.bathrooms != null && existing.bathrooms == null)
          patch.bathrooms = orData.bathrooms

        if (orData.sqft != null && !existing.square_footage)
          patch.square_footage = orData.sqft

        if (Object.keys(patch).length > 0) {
          const { error } = await supabase
            .from('properties')
            .update(patch)
            .eq('id', existing.id)
          if (error) failures.push(`${existing.id}: ${error.message}`)
        }
      }

      if (failures.length) {
        // Non-fatal: don't throw — patch failures don't block the booking sync
        logger.error(`[OwnerRez:${user_id}] Property patch failures: ${failures.join(', ')}`)
      }

      logger.info(`[OwnerRez:${user_id}] Patched null fields on ${existingProps.length} properties`)
    })

    // ── Step 2: Fetch and upsert bookings ────────────────────────────────────

    const syncCursor = await step.run('fetch-bookings', async () => {
      if (!fetchPropsResult.ids.length) return new Date().toISOString()

      // MEDIUM-3: capture pre-fetch timestamp as cursor value.
      // Using post-fetch time would miss bookings modified during the fetch window
      // (which can be 30-90 seconds for large tenant histories).
      const fetchStartedAt = new Date().toISOString()

      let bookings: OwnerRezBooking[]

      try {
        bookings = await client.getBookings({ propertyIds: fetchPropsResult.ids, includeGuest: true })
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
          .in('external_id', fetchPropsResult.ids.map(String))

        const externalToFsId = Object.fromEntries(
          (fsProps ?? []).map((p) => [p.external_id, p.id])
        )

        const bookingRows = bookings.map((b) => ({
          org_id,
          property_id:     externalToFsId[String(b.property_id)] ?? null,
          guest_name:      b.guest?.name  ?? null,
          guest_email:     b.guest?.email ?? null,
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

      return fetchStartedAt  // MEDIUM-3: pre-fetch timestamp
    })

    // ── Step 3: Update sync metadata ─────────────────────────────────────────

    await step.run('update-last-synced', async () => {
      const supabase = createServiceClient()
      const { error } = await supabase
        .from('integration_connections')
        .update({
          metadata: {
            sync_cursor:     syncCursor,
            last_synced_at:  new Date().toISOString(),
          },
        })
        .eq('user_id', user_id)
        .eq('provider_id', PROVIDER)

      // MEDIUM-2: throw on cursor failure — a stale cursor causes full re-syncs
      if (error) {
        throw new Error(`[OwnerRez:${user_id}] Failed to persist sync cursor: ${error.message}`)
      }
    })

    // ── Step 4: Auto-activate RepuGuard ──────────────────────────────────────

    await step.run('auto-activate-repuguard', async () => {
      // RepuGuard is bundled for all OwnerRez users — activate on first connect.
      // .in() filter skips orgs already active, so reconnects are safe.
      const supabase = createServiceClient()
      await supabase
        .from('organizations')
        .update({ repuguard_status: 'active' })
        .eq('id', org_id)
        .in('repuguard_status', ['inactive', 'cancelled'])
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
