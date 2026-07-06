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
import { NonRetriableError }    from 'inngest'
import { createServiceClient }  from '@/lib/supabase/server'
import { OwnerRezApiClient }    from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import type { OwnerRezProperty, OwnerRezBooking, OwnerRezListing } from '@/lib/integrations/types'
import {
  buildOwnerRezDetailPatch,
  ownerRezBookingToNormalized,
} from '@/lib/integrations/providers/ownerrez'
import { logAuditEvent }        from '@/lib/audit'
import { applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'
import { generateTurnoversForProperty }   from '@/lib/turnovers/generator'
import {
  seedPresentAssetsFromAmenities,
  seedAbsentOptionalAssetsFromAmenities,
} from '@/lib/asset-discovery/seed-from-amenities'
import {
  ensureGuidebookConfiguration,
  createGuidebookPropertyConfigsForProperties,
  syncGuidebookConfigsFromProperty,
} from '@/lib/guidebook/sync'

const PROVIDER = 'ownerrez'

async function writeSyncCount(
  user_id: string,
  field: 'properties_found' | 'bookings_found',
  value: number
) {
  const supabase = createServiceClient()
  const { data: existing } = await supabase
    .from('integration_connections')
    .select('metadata')
    .eq('user_id', user_id)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {}

  await supabase
    .from('integration_connections')
    .update({ metadata: { ...existingMeta, [field]: value } })
    .eq('user_id', user_id)
    .eq('provider_id', PROVIDER)
}

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

    try {
      // ── Step 1: Fetch and upsert properties ───────────────────────────────

      const fetchPropsResult = await step.run('fetch-properties', async () => {
        await logAuditEvent({
          actorId:    user_id,
          orgId:      org_id,
          action:     'integration.sync_triggered',
          targetType: 'integration_connection',
          targetId:   PROVIDER,
          metadata:   { sync_type: 'initial', workflow_id: workflowId },
        })

        let properties: OwnerRezProperty[]

        try {
          properties = await client.getProperties()
        } catch (err) {
          if (err instanceof RateLimitError) {
            throw err // Inngest will retry
          }
          throw err
        }

        try {
          await writeSyncCount(user_id, 'properties_found', properties.length)
        } catch (countErr) {
          logger.warn(
            `[OwnerRez:${user_id}] writeSyncCount properties_found failed: ${countErr instanceof Error ? countErr.message : String(countErr)}`
          )
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

      // ── Step 1b: Patch null property fields from OwnerRez data ─────────────
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

          if (orData.bedrooms  !== null && !existing.bedrooms)
            patch.bedrooms = orData.bedrooms

          if (orData.bathrooms !== null && existing.bathrooms === null)
            patch.bathrooms = orData.bathrooms

          if (orData.sqft !== null && !existing.square_footage)
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

      // ── Step 1c: Fetch property detail and sync rich fields ──────────────────
      // The /v2/properties list endpoint returns minimal data.
      // /v2/properties/{id} returns WiFi, instructions, and rules.
      // Amenities come from the batch /v2/listings endpoint instead (see Addendum
      // in CLAUDE_55_5.md — avoids a second per-property call for that field).
      //
      // SCALABILITY: this used to be a single non-resumable step.run with a for
      // loop over every property — 50+ properties meant 7+ seconds of sequential
      // external calls in one step, and a retry discarded ALL progress and
      // re-burned OwnerRez quota from scratch. It is now fanned out: a list
      // fetch, a single batch listings fetch, then one memoized step per
      // property. Inngest skips the callback for steps whose IDs already
      // completed, so a retry only re-runs incomplete properties.

      type EnrichTarget = {
        id:                  string
        external_id:         string | null
        wifi_name:           string | null
        wifi_password:       string | null
        access_instructions: string | null
        house_manual:        string | null
        amenities:           Record<string, boolean> | null
      }

      // Step 1c-i: snapshot the properties to enrich (needed in outer scope so
      // the per-property steps below can be fanned out from the loop).
      const enrichTargets = await step.run('fetch-properties-to-enrich', async () => {
        const supabase = createServiceClient()
        const { data } = await supabase
          .from('properties')
          .select('id, external_id, wifi_name, wifi_password, access_instructions, house_manual, amenities')
          .eq('external_source', PROVIDER)
          .eq('org_id', org_id)
          .eq('is_active', true)
        return (data ?? []) as EnrichTarget[]
      })

      // Step 1c-ii: batch fetch amenity listings once (shared across all
      // properties). Returned as a plain object — a Map is not JSON-serialisable
      // as step output.
      const listingByPropertyId = await step.run('fetch-listings-batch', async () => {
        try {
          const listings = await client.getListings({ includeAmenities: true })

          if (listings.length > 0) {
            logger.info('[OwnerRez] listing shape sample', {
              listingKeys:          Object.keys(listings[0]),
              amenityCategoryCount: listings[0]?.amenity_categories?.length ?? 0,
              firstCategoryKeys:    listings[0]?.amenity_categories?.[0] ? Object.keys(listings[0].amenity_categories[0]) : [],
            })
          }

          return Object.fromEntries(
            listings.map((l) => [String(l.property_id), l])
          ) as Record<string, OwnerRezListing>
        } catch (err) {
          logger.warn(`[OwnerRez:${user_id}] getListings failed — continuing without amenities: ${err instanceof Error ? err.message : String(err)}`)
          return {} as Record<string, OwnerRezListing>
        }
      })

      // Step 1c-iii: one memoized step per property for the detail call + patch.
      for (const dbProp of enrichTargets) {
        await step.run(`fetch-property-detail-${dbProp.id}`, async () => {
          const supabase = createServiceClient()
          const orId     = Number(dbProp.external_id)
          const detail   = await client.getPropertyDetail(orId).catch(() => null)

          // NOTE: WiFi, check-in instructions, and house manual are NOT on
          // GET /v2/properties/{id} — they live on the listings endpoint
          // and are mapped from `listing` instead.
          const listing = listingByPropertyId[String(orId)]
          const patch    = buildOwnerRezDetailPatch(dbProp, detail, listing)

          if (Object.keys(patch).length === 0) return { skipped: true }

          patch.updated_at = new Date().toISOString()

          const { error } = await supabase
            .from('properties')
            .update(patch)
            .eq('id', dbProp.id)
            .eq('org_id', org_id) // explicit tenant guard

          if (error) throw new Error(`Failed to patch property ${dbProp.id}: ${error.message}`)

          // Distribute the rate-limit delay across steps — each property's
          // detail call paces itself rather than hammering OwnerRez back-to-back.
          await new Promise((r) => setTimeout(r, 150))

          return { patched: Object.keys(patch) }
        })
      }

      logger.info(`[OwnerRez:${user_id}] Fetched property details for ${enrichTargets.length} properties`)

      // ── Step 1d: Apply master checklist to newly-synced properties ────────────
      // Only applies to properties that do not yet have a default template.
      // Skips any property where the PM has already set one up.

      await step.run('apply-checklist-template', async () => {
        if (!fetchPropsResult.patchData.length) return

        const supabase    = createServiceClient()
        const externalIds = fetchPropsResult.patchData.map((p) => p.externalId)

        const { data: properties } = await supabase
          .from('properties')
          .select('id')
          .eq('org_id', org_id)
          .eq('external_source', PROVIDER)
          .in('external_id', externalIds)

        if (!properties?.length) return

        // Filter to properties without an existing default template
        const { data: existingTemplates } = await supabase
          .from('checklist_templates')
          .select('property_id')
          .eq('org_id', org_id)
          .eq('is_default', true)
          .in('property_id', properties.map((p) => p.id))

        const hasTemplate = new Set((existingTemplates ?? []).map((t) => t.property_id as string))
        const toApply     = properties.filter((p) => !hasTemplate.has(p.id as string))

        for (const property of toApply) {
          await applyMasterChecklistToProperty(property.id as string, org_id, supabase, {
            force:   false,
            actorId: user_id,
          })
        }

        logger.info(
          `[OwnerRez:${user_id}] Applied master checklist to ${toApply.length} of ${properties.length} properties`
        )
      })

      // ── Step 1e: Seed asset discovery from stored amenity data ─────────────
      // properties.amenities is a Record<string, boolean> written during the
      // fetch-property-detail-* steps above. We read it here (no extra API call)
      // and mark optional asset types that are NOT present at this property as
      // is_na = true — dropping them from the crew's discovery queue immediately.
      // Non-fatal: a failure here only means the discovery queue is slightly
      // larger than optimal — it does not block any other sync step.
      await step.run('seed-asset-discovery-from-amenities', async () => {
        try {
          const { seeded, total } = await seedAbsentOptionalAssetsFromAmenities(org_id)
          logger.info(`[OwnerRez:${user_id}] Asset discovery seeded for ${seeded}/${total} properties`)
        } catch (err) {
          logger.warn(`[OwnerRez:${user_id}] asset discovery seed failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })

      // ── Step 1f: Seed confirmed-present assets from amenity data ───────────
      // Complements the step above: creates a bare-stub, active property_assets
      // row (is_na: false, no make/model) for washer/dryer/dishwasher/microwave/
      // refrigerator/oven_range/fire_extinguisher when amenity data confirms
      // they're present. Crew discovery still runs normally to capture full
      // details later — see seedPresentAssetsFromAmenities() for why.
      await step.run('seed-present-assets-from-amenities', async () => {
        try {
          const { seeded, total } = await seedPresentAssetsFromAmenities(org_id)
          logger.info(`[OwnerRez:${user_id}] Present-asset seeding: ${seeded}/${total} properties`)
        } catch (err) {
          logger.error(`[OwnerRez:${user_id}] present-asset seeding failed: ${err instanceof Error ? err.message : String(err)}`)
          // Non-fatal — don't throw, don't block the sync
        }
      })

      // ── Create org-level guidebook config with 30-day trial ───────────────────
      // ensureGuidebookConfiguration is idempotent — never overwrites an
      // existing trial (e.g. if the org reconnects OwnerRez after already
      // having a config).
      await step.run('create-guidebook-org-config', async () => {
        await ensureGuidebookConfiguration(org_id)
      })

      // ── Auto-create guidebook property configs for new properties ─────────────
      await step.run('create-guidebook-property-configs', async () => {
        try {
          await createGuidebookPropertyConfigsForProperties(org_id)
        } catch (err) {
          logger.error(`[OwnerRez:${user_id}] guidebook config creation failed: ${err instanceof Error ? err.message : String(err)}`)
          // Non-fatal — don't throw, don't block the sync
        }
      })

      // ── Sync property data into guidebook configs ──────────────────────────
      // guidebook_property_configs stores guest-facing content. If a PM has
      // already filled in their check-in instructions in OwnerRez, pre-populate
      // the guidebook config with that data. Never overwrites PM-entered values.
      await step.run('sync-guidebook-configs-from-property', async () => {
        await syncGuidebookConfigsFromProperty(org_id, PROVIDER)
        logger.info(`[OwnerRez:${user_id}] Synced guidebook configs for org ${org_id}`)
      })

      // ── Step 2: Fetch and upsert bookings ───────────────────────────────────

      const fetchBookingsResult = await step.run('fetch-bookings', async () => {
        if (!fetchPropsResult.ids.length) {
          try {
            await writeSyncCount(user_id, 'bookings_found', 0)
          } catch (countErr) {
            logger.warn(
              `[OwnerRez:${user_id}] writeSyncCount bookings_found failed: ${countErr instanceof Error ? countErr.message : String(countErr)}`
            )
          }
          return { cursor: new Date().toISOString(), count: 0, affectedPropertyIds: [] as string[] }
        }

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

        let affectedPropertyIds: string[] = []

        if (bookings.length) {
          const supabase   = createServiceClient()

          // Resolve FieldStay property IDs from external IDs
          const { data: fsProps, error: propsLookupError } = await supabase
            .from('properties')
            .select('id, external_id')
            .eq('org_id', org_id)
            .eq('external_source', PROVIDER)
            .in('external_id', fetchPropsResult.ids.map(String))

          if (propsLookupError || !fsProps) {
            console.error(
              `[OwnerRez sync] Property lookup failed for org ${org_id} — ` +
              `skipping booking upsert to prevent property_id null overwrite`,
              propsLookupError?.message
            )
            throw new Error(
              `Property lookup failed for org ${org_id}: ${propsLookupError?.message ?? 'unknown error'}`
            )
          }

          const externalToFsId = Object.fromEntries(
            fsProps.map((p) => [p.external_id, p.id])
          )

          // NOTE: checkin_time/checkout_time are intentionally omitted here.
          // OwnerRez's booking endpoint never provides a time-of-day (unlike
          // Hospitable's check_in/check_out), so ownerRezBookingToNormalized
          // always returns null for both — writing that null on every sync
          // would silently clobber a PM's manual edit to those fields
          // (see app/(dashboard)/bookings/actions.ts). Omitting the keys
          // entirely leaves them untouched on conflict, same as before this
          // extraction.
          const bookingRows = bookings.map((b) => {
            const normalized = ownerRezBookingToNormalized(b)
            return {
              org_id,
              property_id:     normalized.property_external_id
                                 ? (externalToFsId[normalized.property_external_id] ?? null)
                                 : null,
              external_source: PROVIDER,
              external_id:     normalized.external_id,
              // b.arrival/b.departure used directly so these stay typed as
              // non-nullable strings — OwnerRez always has both, unlike
              // Hospitable where the normalized fields can be null.
              checkin_date:    b.arrival,
              checkout_date:   b.departure,
              status:          normalized.status,
              guest_name:      normalized.guest_name,
              guest_email:     normalized.guest_email,
              source:          normalized.source,
              is_block:        normalized.is_block,
            }
          })

          const { error } = await supabase
            .from('bookings')
            .upsert(bookingRows, { onConflict: 'external_id,external_source' })

          if (error) {
            logger.error(`[OwnerRez:${user_id}] bookings upsert failed: ${error.message}`)
            throw new Error(error.message)
          }

          logger.info(`[OwnerRez:${user_id}] Upserted ${bookingRows.length} bookings`)

          affectedPropertyIds = Array.from(new Set(
            bookingRows.map((b) => b.property_id).filter((id): id is string => id !== null)
          ))
        }

        try {
          await writeSyncCount(user_id, 'bookings_found', bookings.length)
        } catch (countErr) {
          logger.warn(
            `[OwnerRez:${user_id}] writeSyncCount bookings_found failed: ${countErr instanceof Error ? countErr.message : String(countErr)}`
          )
        }

        return { cursor: fetchStartedAt, count: bookings.length, affectedPropertyIds }  // MEDIUM-3: pre-fetch timestamp
      })

      // ── Step 3: Update sync metadata ────────────────────────────────────────

      await step.run('update-last-synced', async () => {
        const supabase = createServiceClient()

        const { data: existing } = await supabase
          .from('integration_connections')
          .select('metadata')
          .eq('user_id', user_id)
          .eq('provider_id', PROVIDER)
          .maybeSingle()

        const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {}

        const { error } = await supabase
          .from('integration_connections')
          .update({
            metadata: {
              ...existingMeta,
              sync_cursor:       fetchBookingsResult.cursor,
              last_synced_at:    new Date().toISOString(),
              last_sync_status:  'success',
              last_sync_error:   null,
              last_sync_count:   fetchBookingsResult.count,
            },
          })
          .eq('user_id', user_id)
          .eq('provider_id', PROVIDER)

        // MEDIUM-2: throw on cursor failure — a stale cursor causes full re-syncs
        if (error) {
          throw new Error(`[OwnerRez:${user_id}] Failed to persist sync cursor: ${error.message}`)
        }
      })

      // ── Step 4: Generate turnovers for synced properties ─────────────────────
      // Called once per property (not per booking) so the generator sees the
      // full booking list and can apply its two-pass pairing logic correctly.

      const newTurnoverIds = await step.run('generate-turnovers', async () => {
        const propertyIds = fetchBookingsResult.affectedPropertyIds
        if (!propertyIds.length) return []
        const supabase = createServiceClient()
        const ids: string[] = []
        for (const propertyId of propertyIds) {
          try {
            const newIds = await generateTurnoversForProperty(propertyId, org_id, supabase)
            ids.push(...newIds)
          } catch (err) {
            logger.error(
              `[OwnerRez:${user_id}] Turnover generation failed for property ${propertyId}: ${err}`
            )
            // Don't let one property's failure block the others
          }
        }
        return ids
      })

      if (newTurnoverIds.length > 0) {
        const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
          const supabase = createServiceClient()
          type TurnoverRow = { id: string; property_id: string; checkout_datetime: string; checkin_datetime: string; window_minutes: number | null }
          const { data: turnovers } = await supabase
            .from('turnovers')
            .select('id, property_id, checkout_datetime, checkin_datetime, window_minutes')
            .in('id', newTurnoverIds)

          return (turnovers as TurnoverRow[] ?? []).map((t) => ({
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
    } catch (err) {
      const humanError = translateSyncError(err)
      logger.error(
        `[OwnerRez:${user_id}] initial sync failed: ${err instanceof Error ? err.message : String(err)}`
      )

      await step.run('handle-sync-failure', async () => {
        const supabase = createServiceClient()
        const isRevoked = err instanceof TokenRevokedError

        const { data: existing } = await supabase
          .from('integration_connections')
          .select('id, metadata')
          .eq('user_id', user_id)
          .eq('provider_id', PROVIDER)
          .maybeSingle()

        const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {}

        await supabase
          .from('integration_connections')
          .update({
            status:   isRevoked ? 'revoked' : 'error',
            metadata: {
              ...existingMeta,
              last_sync_status: 'error',
              last_sync_error:  humanError,
              last_synced_at:   new Date().toISOString(),
            },
          })
          .eq('user_id', user_id)
          .eq('provider_id', PROVIDER)

        await logAuditEvent({
          orgId:      org_id,
          actorId:    user_id,
          action:     'integration.sync_failed',
          targetType: 'integration_connection',
          targetId:   PROVIDER,
          metadata:   {
            provider_id: PROVIDER,
            error:       humanError,
            workflow_id: workflowId,
            sync_type:   'initial',
            ...(isRevoked ? { reason: 'token_revoked' } : {}),
          },
        })

        // Fire PM notification — throttled to once per 4 hours per connection.
        // Revoked tokens are the most important case to notify on: only the PM
        // can fix them by reconnecting, and they never self-resolve on retry.
        if (existing?.id) {
          const milestoneKey = `integration_error_notified:${existing.id}`
          const { data: recentNotification } = await supabase
            .from('org_milestones')
            .select('value, achieved_at')
            .eq('org_id', org_id)
            .eq('milestone', milestoneKey)
            .order('achieved_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          const lastNotifiedAt = (recentNotification?.value as Record<string, unknown> | null)
            ?.notified_at
          const tooSoon = lastNotifiedAt &&
            Date.now() - new Date(lastNotifiedAt as string).getTime() < 4 * 60 * 60 * 1000

          if (!tooSoon) {
            await step.sendEvent('notify-connection-error', {
              name: 'integration/connection.error',
              data: {
                user_id:     user_id,
                org_id:      org_id,
                provider_id: PROVIDER,
                reason:      humanError,
              },
            })
            await supabase.from('org_milestones').upsert({
              org_id:    org_id,
              milestone: milestoneKey,
              value:     { notified_at: new Date().toISOString() },
            }, { onConflict: 'org_id,milestone' })
          }
        }
      })

      // MEDIUM-6: token revocation is permanent — retrying just re-hits the
      // same revoked token, burning all 3 retries for nothing. Throw
      // NonRetriableError (after the side effects above already completed)
      // so Inngest stops immediately and the dashboard distinguishes this
      // from a transient failure.
      if (err instanceof TokenRevokedError) {
        throw new NonRetriableError(humanError)
      }

      // RE-THROW so Inngest records this as a failure and retries it.
      // Do NOT return { synced: false } — that silently marks the run
      // as successful and prevents retries.
      throw err
    }

    // ── Step 4: Auto-activate RepuGuard ────────────────────────────────────────

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

    // ── Step 5: Register entity webhook subscriptions ──────────────────────────

    await step.run('register-entity-webhooks', async () => {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL
      if (!appUrl) {
        logger.warn('[OwnerRez] NEXT_PUBLIC_APP_URL not set — skipping webhook registration')
        return
      }
      const webhookUrl = `${appUrl}/api/webhooks/ownerrez`
      try {
        await client.registerWebhookSubscriptions(webhookUrl)
        logger.info(`[OwnerRez:${user_id}] Entity webhook subscriptions registered`)
      } catch (err) {
        // Non-fatal: polling fallback still works. Log and continue.
        logger.error(
          `[OwnerRez:${user_id}] Webhook registration failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    })

    return { user_id, synced: true }
  }
)
