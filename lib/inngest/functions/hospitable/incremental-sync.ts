// lib/inngest/functions/hospitable/incremental-sync.ts
// ============================================================
// Triggered by: integration/hospitable.sync.requested
// Fired by:     handleWebhookEvent (hospitable.ts provider adapter)
//
// Entity routing:
//   reservation → upsert booking, regenerate turnovers if dates changed
//   property    → update property fields from Hospitable API
//   review      → upsert review, fire repuguard/batch_generate.requested
//
// Token validity is ensured before every API fetch via getValidHospitableToken.
//
// All step.run() calls are at outer function scope — no helper receives step.
// ============================================================

import { inngest }                 from '@/lib/inngest/client'
import { NonRetriableError }       from 'inngest'
import { createServiceClient }     from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import {
  mapHospitableStatus,
  mapHospitableChannel,
  resolveHospitableTimezone,
  extractHospitableTime,
  normalizeHospitableAmenities,
  type HospitableReservation,
  type HospitableProperty,
} from '@/lib/integrations/providers/hospitable'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import {
  createGuidebookPropertyConfigsForProperties,
  syncGuidebookConfigsFromProperty,
} from '@/lib/guidebook/sync'
import {
  seedPresentAssetsFromAmenities,
  seedAbsentOptionalAssetsFromAmenities,
} from '@/lib/asset-discovery/seed-from-amenities'

const HOSPITABLE_API_BASE = 'https://public.api.hospitable.com/v2'
const PROVIDER            = 'hospitable'

function buildApiHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  }
}

export const hospIncrementalSync = inngest.createFunction(
  {
    id:          'hospitable-incremental-sync',
    name:        'Hospitable: Incremental Sync',
    retries:     3,
    concurrency: { limit: 2, key: 'event.data.entity_id' },
  },
  { event: 'integration/hospitable.sync.requested' as const },
  async ({ event, step, logger }) => {
    const { provider_id, event_type, entity_type, entity_id } = event.data

    if (provider_id !== PROVIDER) {
      logger.warn(`[Hospitable incremental] Unexpected provider_id: ${provider_id}`)
      return { skipped: true, reason: 'wrong_provider' }
    }

    logger.info(`[Hospitable incremental] ${event_type} / ${entity_type} / ${entity_id}`)

    // ── RESERVATION ──────────────────────────────────────────────────────────
    if (entity_type === 'reservation') {

      const { orgId, token } = await step.run('resolve-org-and-token', async () => {
        const supabase = createServiceClient()

        const { data: booking } = await supabase
          .from('bookings')
          .select('org_id')
          .eq('external_id',     entity_id)
          .eq('external_source', PROVIDER)
          .maybeSingle()

        let resolvedOrgId: string | null = booking?.org_id ?? null
        let pmUserId: string | null      = null

        if (resolvedOrgId) {
          const { data: member } = await supabase
            .from('organization_members')
            .select('user_id')
            .eq('org_id', resolvedOrgId)
            .in('role', ['owner', 'admin'])
            .not('invite_accepted_at', 'is', null)
            .limit(1)
            .single()

          if (!member) throw new NonRetriableError(`No admin for org ${resolvedOrgId}`)
          pmUserId = member.user_id
        } else {
          // New reservation — find via an active Hospitable connection
          const { data: connection } = await supabase
            .from('integration_connections')
            .select('user_id, org_id')
            .eq('provider_id', PROVIDER)
            .eq('status',      'active')
            .not('org_id',     'is', null)
            .limit(1)
            .single()

          if (!connection) {
            throw new NonRetriableError('No active Hospitable connection found')
          }
          pmUserId      = connection.user_id
          resolvedOrgId = connection.org_id
        }

        const validToken = await getValidHospitableToken(pmUserId!)
        return { orgId: resolvedOrgId!, token: validToken }
      })

      const reservation = await step.run('fetch-reservation', async () => {
        const res = await fetch(
          `${HOSPITABLE_API_BASE}/reservations/${entity_id}?include=guest,properties`,
          { headers: buildApiHeaders(token) }
        )

        if (res.status === 404) return null

        if (!res.ok) {
          throw new Error(
            `Hospitable GET /reservations/${entity_id} failed: HTTP ${res.status}`
          )
        }

        const data = await res.json() as { data: HospitableReservation }
        return data.data
      })

      if (!reservation) {
        await step.run('mark-cancelled', async () => {
          const supabase = createServiceClient()
          const { error } = await supabase
            .from('bookings')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('external_id',     entity_id)
            .eq('external_source', PROVIDER)
            .eq('org_id',          orgId)

          if (error) throw new Error(`mark-cancelled failed: ${error.message}`)
        })
        logger.info(`[Hospitable incremental] Reservation ${entity_id} cancelled`)
        return { action: 'cancelled', entity_id }
      }

      const upsertResult = await step.run('upsert-booking', async () => {
        const supabase       = createServiceClient()
        // Confirmed from the official Hospitable webhook spec: 'properties'
        // is an array[Property], not a singular 'property' object.
        const hospPropertyId = reservation.properties?.[0]?.id ?? null

        if (!hospPropertyId) {
          throw new NonRetriableError(
            `Reservation ${entity_id} has no property reference in Hospitable response`
          )
        }

        const { data: property } = await supabase
          .from('properties')
          .select('id')
          .eq('external_id',     hospPropertyId)
          .eq('external_source', PROVIDER)
          .maybeSingle()

        if (!property) {
          throw new Error(
            `Property ${hospPropertyId} not in FieldStay — ` +
            `reservation upsert will retry after property sync completes`
          )
        }

        const { data: existing } = await supabase
          .from('bookings')
          .select('checkin_date, checkout_date')
          .eq('external_id',     entity_id)
          .eq('external_source', PROVIDER)
          .maybeSingle()

        const datesChanged = !existing
          || existing.checkin_date  !== (reservation.arrival_date?.split('T')[0]   ?? null)
          || existing.checkout_date !== (reservation.departure_date?.split('T')[0] ?? null)

        const status = mapHospitableStatus(reservation.reservation_status.current.category)

        // reservation.guest (singular) = GuestInfo name data (via include=guest)
        // reservation.guests (plural)  = GuestCounts — not name data
        const guest     = reservation.guest ?? null
        const guestName = guest
          ? [guest.first_name, guest.last_name].filter(Boolean).join(' ') || null
          : null

        const { error } = await supabase
          .from('bookings')
          .upsert(
            {
              org_id:          orgId,
              property_id:     property.id,
              external_id:     reservation.id,
              external_source: PROVIDER,
              checkin_date:    reservation.arrival_date?.split('T')[0]   ?? null,
              checkout_date:   reservation.departure_date?.split('T')[0] ?? null,
              checkin_time:    extractHospitableTime(reservation.check_in,  '15:00'),
              checkout_time:   extractHospitableTime(reservation.check_out, '11:00'),
              status,
              guest_name:      guestName,
              source:          mapHospitableChannel(reservation.platform),
              is_block:        false,
            },
            { onConflict: 'external_id,external_source' }
          )

        if (error) throw new Error(`Booking upsert failed: ${error.message}`)

        return { datesChanged, propertyId: property.id }
      })

      // Regenerate turnovers only when dates changed.
      // generateTurnoversForProperty returns string[] (new turnover IDs) —
      // we then fetch the full rows to build turnover/created events.
      if (upsertResult.datesChanged) {
        const newTurnoverIds = await step.run('regenerate-turnovers', async () => {
          const supabase = createServiceClient()
          return generateTurnoversForProperty(upsertResult.propertyId, orgId, supabase)
        })

        if (newTurnoverIds.length > 0) {
          const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
            const supabase = createServiceClient()
            type TRow = {
              id:                string
              property_id:       string
              checkout_datetime: string
              checkin_datetime:  string
              window_minutes:    number | null
            }
            const { data: turnovers } = await supabase
              .from('turnovers')
              .select('id, property_id, checkout_datetime, checkin_datetime, window_minutes')
              .in('id', newTurnoverIds)

            return ((turnovers as TRow[]) ?? []).map((t) => ({
              name: 'turnover/created' as const,
              data: {
                turnover_id:       t.id,
                property_id:       t.property_id,
                org_id:            orgId,
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
      }

      return { action: 'upserted', entity_id, datesChanged: upsertResult.datesChanged }
    }

    // ── PROPERTY ─────────────────────────────────────────────────────────────
    if (entity_type === 'property') {

      const { orgId, token } = await step.run('resolve-org-and-token', async () => {
        const supabase = createServiceClient()

        const { data: property } = await supabase
          .from('properties')
          .select('org_id')
          .eq('external_id',     entity_id)
          .eq('external_source', PROVIDER)
          .maybeSingle()

        if (!property) {
          throw new NonRetriableError(
            `Property ${entity_id} not in FieldStay — unknown properties cannot be synced incrementally`
          )
        }

        const { data: member } = await supabase
          .from('organization_members')
          .select('user_id')
          .eq('org_id', property.org_id)
          .in('role', ['owner', 'admin'])
          .not('invite_accepted_at', 'is', null)
          .limit(1)
          .single()

        if (!member) throw new NonRetriableError(`No admin for org ${property.org_id}`)

        const validToken = await getValidHospitableToken(member.user_id)
        return { orgId: property.org_id, token: validToken }
      })

      const fetchAndUpsertResult = await step.run('fetch-and-upsert-property', async () => {
        const res = await fetch(
          `${HOSPITABLE_API_BASE}/properties/${entity_id}?include=details`,
          { headers: buildApiHeaders(token) }
        )

        if (res.status === 404) {
          const supabase = createServiceClient()
          const { error } = await supabase
            .from('properties')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('external_id',     entity_id)
            .eq('external_source', PROVIDER)
            .eq('org_id',          orgId)

          if (error) throw new Error(`mark-inactive failed: ${error.message}`)
          logger.info(`[Hospitable incremental] Property ${entity_id} marked inactive`)
          return { action: 'deactivated', propertyId: undefined as string | undefined }
        }

        if (!res.ok) {
          throw new Error(
            `Hospitable GET /properties/${entity_id} failed: HTTP ${res.status}`
          )
        }

        const data     = await res.json() as { data: HospitableProperty }
        const prop     = data.data
        const addr     = prop.address
        const addressStr = [addr.number, addr.street].filter(Boolean).join(' ') || null

        const supabase = createServiceClient()
        const { data: updated, error } = await supabase
          .from('properties')
          .update({
            name:          prop.public_name || prop.name,
            address:       addressStr,
            city:          addr.city     ?? null,
            state:         addr.state    ?? null,
            zip:           addr.postcode ?? null,
            bedrooms:      prop.capacity.bedrooms  ?? 1,
            bathrooms:     prop.capacity.bathrooms ?? 1,
            max_guests:    prop.capacity.max       ?? 2,
            checkin_time:  prop.checkin  ?? '15:00',
            checkout_time: prop.checkout ?? '11:00',
            timezone:      resolveHospitableTimezone(prop.timezone, addr.state),
            // Do NOT set is_active from prop.listed — listed means "published
            // to a channel," not "still in the PM's portfolio." A property
            // unlisted from Airbnb should stay active in FieldStay; the only
            // path that deactivates a property is the 404 branch above, which
            // means Hospitable itself no longer has the property at all.
            //
            // Staging fields for the guidebook sync — see initial-sync.ts for
            // the full explanation. syncGuidebookConfigsFromProperty() below
            // copies these into guidebook_property_configs only where the PM
            // hasn't already entered their own value.
            wifi_name:           prop.details?.wifi_name     || null,
            wifi_password:       prop.details?.wifi_password || null,
            access_instructions: prop.details?.guest_access  || null,
            house_manual:        prop.details?.house_manual  || null,
            amenities:           normalizeHospitableAmenities(prop.amenities),
            smoking_allowed:     prop.house_rules?.smoking_allowed ?? null,
            pets_allowed:        prop.house_rules?.pets_allowed    ?? null,
            events_allowed:      prop.house_rules?.events_allowed  ?? null,
            updated_at:    new Date().toISOString(),
          })
          .eq('external_id',     entity_id)
          .eq('external_source', PROVIDER)
          .eq('org_id',          orgId)
          .select('id')
          .single()

        if (error) throw new Error(`Property update failed: ${error.message}`)
        return { action: 'updated', propertyId: updated?.id as string | undefined }
      })

      const propertyId = fetchAndUpsertResult?.propertyId
      if (propertyId) {
        await step.run('sync-guidebook-config-for-property', async () => {
          try {
            await createGuidebookPropertyConfigsForProperties(orgId, [propertyId])
            await syncGuidebookConfigsFromProperty(orgId, PROVIDER, [propertyId])
          } catch (err) {
            logger.error(`[Hospitable incremental] guidebook config sync failed for property ${propertyId}: ${err instanceof Error ? err.message : String(err)}`)
            // Non-fatal — don't throw, don't block the sync
          }
        })

        await step.run('seed-asset-discovery-for-property', async () => {
          try {
            const { seeded } = await seedPresentAssetsFromAmenities(orgId, [propertyId])
            logger.info(`[Hospitable incremental] Asset discovery seeded for property ${propertyId}: ${seeded ? 'yes' : 'no new assets'}`)
          } catch (err) {
            logger.error(`[Hospitable incremental] asset discovery seed failed for property ${propertyId}: ${err instanceof Error ? err.message : String(err)}`)
            // Non-fatal — don't throw, don't block the sync
          }
        })

        await step.run('seed-absent-optional-assets-for-property', async () => {
          try {
            await seedAbsentOptionalAssetsFromAmenities(orgId, [propertyId])
          } catch (err) {
            logger.warn(`[Hospitable incremental] absent-optional-asset seeding failed for property ${propertyId}: ${err instanceof Error ? err.message : String(err)}`)
            // Non-fatal — don't throw, don't block the sync
          }
        })
      }

      return { action: 'synced', entity_id }
    }

    // ── REVIEW ────────────────────────────────────────────────────────────────
    if (entity_type === 'review') {

      const { orgId, token } = await step.run('resolve-org-and-token', async () => {
        const supabase = createServiceClient()

        // Fast path: review already in FieldStay
        const { data: existingReview } = await supabase
          .from('reviews')
          .select('org_id')
          .eq('external_id',     entity_id)
          .eq('external_source', PROVIDER)
          .maybeSingle()

        if (existingReview) {
          const { data: member } = await supabase
            .from('organization_members')
            .select('user_id')
            .eq('org_id', existingReview.org_id)
            .in('role', ['owner', 'admin'])
            .not('invite_accepted_at', 'is', null)
            .limit(1)
            .single()

          if (!member) throw new NonRetriableError(`No admin for org ${existingReview.org_id}`)
          const validToken = await getValidHospitableToken(member.user_id)
          return { orgId: existingReview.org_id, token: validToken }
        }

        // New review — use any active connection; org will be resolved via property in next step
        const { data: connection } = await supabase
          .from('integration_connections')
          .select('user_id, org_id')
          .eq('provider_id', PROVIDER)
          .eq('status',      'active')
          .not('org_id',     'is', null)
          .limit(1)
          .single()

        if (!connection) {
          throw new NonRetriableError('No active Hospitable connection found for review sync')
        }

        const validToken = await getValidHospitableToken(connection.user_id)
        return { orgId: connection.org_id!, token: validToken }
      })

      // Fetch review and upsert using live reviews table schema:
      //   guest_name, review_text, rating (NOT NULL), review_date, property_id (UUID FK)
      // ⚠️ Confirm /reviews/{id} endpoint path from first real Hospitable delivery.
      const upsertResult = await step.run('fetch-and-upsert-review', async () => {
        const res = await fetch(
          `${HOSPITABLE_API_BASE}/reviews/${entity_id}`,
          { headers: buildApiHeaders(token) }
        )

        if (!res.ok) {
          if (res.status === 404) {
            throw new NonRetriableError(
              `Review ${entity_id} returned 404 from Hospitable — skipping`
            )
          }
          throw new Error(
            `Hospitable GET /reviews/${entity_id} failed: HTTP ${res.status}`
          )
        }

        const data   = await res.json() as { data: Record<string, unknown> }
        const review = data.data

        const supabase          = createServiceClient()
        let   resolvedOrgId     = orgId
        let   resolvedPropertyId: string | null = null

        // Resolve property_id (FK) and correct org from the Hospitable property UUID
        const hospPropertyId = review.property_id as string | null
        if (hospPropertyId) {
          const { data: prop } = await supabase
            .from('properties')
            .select('id, org_id')
            .eq('external_id',     hospPropertyId)
            .eq('external_source', PROVIDER)
            .maybeSingle()

          if (prop) {
            resolvedOrgId      = prop.org_id
            resolvedPropertyId = prop.id
          }
        }

        const { data: upserted, error } = await supabase
          .from('reviews')
          .upsert(
            {
              org_id:          resolvedOrgId,
              external_id:     entity_id,
              external_source: PROVIDER,
              property_id:     resolvedPropertyId,
              guest_name:      (review.guest_name as string | null) ?? null,
              rating:          (review.rating as number | null) ?? 0,
              review_text:     (review.public_review as string | null) ?? '',
              review_date:     (review.submitted_at as string | null) ?? null,
              response_status: 'pending',
            },
            { onConflict: 'external_id,external_source' }
          )
          .select('id')
          .single()

        if (error) throw new Error(`Review upsert failed: ${error.message}`)

        return { upserted: true, reviewId: upserted?.id, orgId: resolvedOrgId }
      })

      // Trigger RepuGuard batch generation for this org.
      // Event name confirmed from repuguard-batch-generate.ts: 'repuguard/batch_generate.requested'
      if (upsertResult.upserted) {
        await step.sendEvent('trigger-repuguard', {
          name: 'repuguard/batch_generate.requested' as const,
          data: {
            org_id:       upsertResult.orgId,
            requested_by: 'hospitable-webhook',
          },
        })
      }

      return { action: 'synced', entity_id }
    }

    logger.warn(`[Hospitable incremental] Unhandled entity_type: ${entity_type}`)
    return { skipped: true, reason: `unknown_entity_type:${entity_type}` }
  }
)
