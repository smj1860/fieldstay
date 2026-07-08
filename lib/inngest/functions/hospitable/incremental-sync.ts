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
  hospitableFetch,
  hospitablePropertyToNormalized,
  hospitableReservationToNormalized,
  type HospitableReservation,
  type HospitableProperty,
} from '@/lib/integrations/providers/hospitable'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
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

// Reservation `triggers` values that don't correspond to anything
// NormalizedBooking/the `bookings` table stores:
//   guests_changed        → guest counts, we don't store these (only guest name/email)
//   notes_changed         → internal conversation notes, not synced
//   financials_changed    → not synced (financials:read not granted)
//   guest_issue_detected  → issue_alert field, not synced
// Deliberately NOT included (so they still trigger a re-fetch): status_changed,
// dates_changed, checkin_changed, checkout_changed (all map directly to
// columns we write), and listing_changed (could mean the reservation moved
// to a different property — safer to re-fetch and re-resolve than assume).
const IRRELEVANT_RESERVATION_TRIGGERS = new Set([
  'guests_changed',
  'notes_changed',
  'financials_changed',
  'guest_issue_detected',
])

export const hospIncrementalSync = inngest.createFunction(
  {
    id:          'hospitable-incremental-sync',
    name:        'Hospitable: Incremental Sync',
    retries:     3,
    concurrency: { limit: 2, key: 'event.data.entity_id' },
  },
  { event: 'integration/hospitable.sync.requested' as const },
  async ({ event, step, logger }) => {
    const { provider_id, event_type, entity_type, entity_id, triggers } = event.data

    if (provider_id !== PROVIDER) {
      logger.warn(`[Hospitable incremental] Unexpected provider_id: ${provider_id}`)
      return { skipped: true, reason: 'wrong_provider' }
    }

    logger.info(`[Hospitable incremental] ${event_type} / ${entity_type} / ${entity_id}`)

    // ── RESERVATION ──────────────────────────────────────────────────────────
    if (entity_type === 'reservation') {

      // Hospitable's `triggers` array names what changed. If every trigger
      // present is one FieldStay doesn't store anything for, skip the
      // re-fetch entirely rather than hitting the API for no reason.
      // Absent (e.g. reservation.created has none) or containing anything
      // outside this set proceeds normally — this is an efficiency skip
      // only, never the basis for deciding what actually changed once we
      // do fetch (that's still the before/after date comparison below).
      if (triggers?.length && triggers.every((t) => IRRELEVANT_RESERVATION_TRIGGERS.has(t))) {
        logger.info(`[Hospitable incremental] Skipping ${entity_id} — only irrelevant triggers: ${triggers.join(', ')}`)
        return { action: 'skipped', reason: 'irrelevant_trigger', entity_id, triggers }
      }

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
        const res = await hospitableFetch(
          `${HOSPITABLE_API_BASE}/reservations/${entity_id}?include=guest,properties`,
          token
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

        const normalized = hospitableReservationToNormalized(reservation)

        const datesChanged = !existing
          || existing.checkin_date  !== normalized.checkin_date
          || existing.checkout_date !== normalized.checkout_date

        const { error } = await supabase
          .from('bookings')
          .upsert(
            {
              org_id:          orgId,
              property_id:     property.id,
              external_source: PROVIDER,
              external_id:     normalized.external_id,
              checkin_date:    normalized.checkin_date,
              checkout_date:   normalized.checkout_date,
              checkin_time:    normalized.checkin_time,
              checkout_time:   normalized.checkout_time,
              status:          normalized.status,
              guest_name:      normalized.guest_name,
              guest_email:     normalized.guest_email,
              source:          normalized.source,
              is_block:        normalized.is_block,
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

      const { orgId, token, isNewProperty } = await step.run('resolve-org-and-token', async () => {
        const supabase = createServiceClient()

        const { data: property } = await supabase
          .from('properties')
          .select('org_id')
          .eq('external_id',     entity_id)
          .eq('external_source', PROVIDER)
          .maybeSingle()

        let resolvedOrgId: string | null = property?.org_id ?? null
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
          // New property (property.created / property.merged for a property
          // FieldStay hasn't synced yet) — find via an active Hospitable
          // connection, same fallback used by the reservation and review
          // handlers below.
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
        return { orgId: resolvedOrgId!, token: validToken, isNewProperty: !property }
      })

      const fetchAndUpsertResult = await step.run('fetch-and-upsert-property', async () => {
        const res = await hospitableFetch(
          `${HOSPITABLE_API_BASE}/properties/${entity_id}?include=details`,
          token
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
          return { action: 'deactivated', propertyId: undefined as string | undefined, propertyName: undefined as string | undefined }
        }

        if (!res.ok) {
          throw new Error(
            `Hospitable GET /properties/${entity_id} failed: HTTP ${res.status}`
          )
        }

        const data = await res.json() as { data: HospitableProperty }
        const prop = data.data

        // Do NOT set is_active from prop.listed — listed means "published to
        // a channel," not "still in the PM's portfolio." A property unlisted
        // from Airbnb should stay active in FieldStay; the only path that
        // deactivates a property is the 404 branch above, which means
        // Hospitable itself no longer has the property at all.
        //
        // The PMS is always the source of truth for every field here,
        // including wifi_name/wifi_password/access_instructions/house_manual
        // (PM-editable elsewhere) — upsertNormalizedProperties() logs an
        // audit event before overwriting a real existing value for those,
        // rather than blocking the overwrite. See lib/properties/normalize.ts.
        const normalized = hospitablePropertyToNormalized(prop)
        const idMap = await upsertNormalizedProperties(orgId, PROVIDER, [normalized])

        return { action: 'updated', propertyId: idMap[prop.id], propertyName: normalized.name }
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

        // New property FieldStay has never seen before (as opposed to an
        // update to one it already knew about) — nudge the PM to set up its
        // checklist, inventory, and maintenance schedule. Surfaced via the
        // org_milestones banner in app/(dashboard)/layout.tsx.
        if (isNewProperty) {
          await step.run('notify-new-property-setup', async () => {
            try {
              const supabase = createServiceClient()
              const { error } = await supabase
                .from('org_milestones')
                .upsert(
                  {
                    org_id:    orgId,
                    milestone: `new_property_setup:${propertyId}`,
                    value: {
                      property_id:   propertyId,
                      property_name: fetchAndUpsertResult.propertyName ?? 'New property',
                    },
                  },
                  { onConflict: 'org_id,milestone', ignoreDuplicates: true }
                )
              if (error) throw new Error(error.message)
            } catch (err) {
              logger.error(`[Hospitable incremental] new-property milestone write failed for property ${propertyId}: ${err instanceof Error ? err.message : String(err)}`)
              // Non-fatal — don't throw, don't block the sync
            }
          })
        }
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
      const upsertResult = await step.run('fetch-and-upsert-review', async () => {
        const res = await hospitableFetch(
          `${HOSPITABLE_API_BASE}/reviews/${entity_id}`,
          token
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

        // Confirmed shape (Hospitable developer docs / webhook payload spec):
        // rating and review text are nested under `public`, the reviewer's
        // name under `guest`, and the date field is `reviewed_at` — NOT the
        // flat `rating`/`public_review`/`guest_name`/`submitted_at` this
        // previously read (which don't exist on the real response and left
        // every synced review with a 0 rating and empty text).
        const data = await res.json() as {
          data: {
            public?:   { rating?: number | null; review?: string | null } | null
            guest?:    { first_name?: string | null; last_name?: string | null } | null
            property?: { id?: string | null } | null
            reviewed_at?: string | null
          }
        }
        const review = data.data

        const supabase          = createServiceClient()
        let   resolvedOrgId     = orgId
        let   resolvedPropertyId: string | null = null

        // Resolve property_id (FK) and correct org from the Hospitable property UUID
        const hospPropertyId = review.property?.id ?? null
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

        const guestName = [review.guest?.first_name, review.guest?.last_name]
          .filter(Boolean)
          .join(' ') || null

        const { data: upserted, error } = await supabase
          .from('reviews')
          .upsert(
            {
              org_id:          resolvedOrgId,
              external_id:     entity_id,
              external_source: PROVIDER,
              property_id:     resolvedPropertyId,
              guest_name:      guestName,
              rating:          review.public?.rating ?? 0,
              review_text:     review.public?.review ?? '',
              review_date:     review.reviewed_at ?? null,
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
