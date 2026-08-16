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
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { OwnerRezApiClient }    from '@/lib/integrations/providers/ownerrez-api'
import { RateLimitError, TokenRevokedError, translateSyncError } from '@/lib/integrations/types'
import type { OwnerRezProperty, OwnerRezBooking, OwnerRezListing } from '@/lib/integrations/types'
import {
  buildOwnerRezDetailPatch,
  buildOwnerRezBookingRow,
  partitionMappedBookingRows,
  selectOwnerRezBookingsToPostRevenue,
} from '@/lib/integrations/providers/ownerrez'
import { upsertBookingsReturningIds } from './upsert-bookings'
import { initialHistoryFrom, revenuePostingFloor } from '@/lib/integrations/providers/ownerrez-backfill'
import { logAuditEvent }        from '@/lib/audit'
import {
  applyMasterChecklistToProperty,
  fetchOrgRoomTemplateData,
  type OrgRoomTemplateData,
} from '@/lib/checklists/apply-master-template'
import { seedDefaultRoomTemplatesIfNeeded } from '@/lib/checklists/seed-default-room-templates'
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
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import {
  shouldNotifyConnectionError,
  recordConnectionErrorNotified,
} from '@/lib/integrations/connection-error-notify'
import type { TablesInsert, TablesUpdate } from '@/types/database'

import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { tryUnwrap, unwrapList } from '@/lib/supabase/unwrap'
const PROVIDER = 'ownerrez'

/**
 * Bookings per booking/confirmed sendEvent step. Sized to keep one step's
 * payload comfortably small while making the step count independent of
 * portfolio size — see the batching note at the call site.
 */
const REVENUE_EVENT_CHUNK = 200

async function writeSyncCount(
  user_id: string,
  field: 'properties_found' | 'bookings_found',
  value: number
) {
  await mergeIntegrationConnectionMetadata({
    userId:     user_id,
    providerId: PROVIDER,
    patch:      { [field]: value },
  })
}

/**
 * The NULL-fill patch for one property: OwnerRez's value is written only where
 * FieldStay currently holds NULL.
 *
 * `!== null` on all three, never a falsy check. A falsy check also matches a
 * legitimate 0 — a studio's bedroom count, a property with no recorded square
 * footage — and would overwrite a PM's manual correction with whatever
 * OwnerRez reports, on every re-run of this step. That regression is covered
 * directly by unit/inngest/ownerrez-initial-sync.test.ts.
 *
 * Pure: two plain objects in, a patch out. Extracted from the loop body so the
 * decision is testable on its own and so patch-property-fields reads as
 * "fetch, decide, write" rather than carrying the field rules inline.
 */
export function buildNullFillPatch(
  orData:   { bedrooms: number | null; bathrooms: number | null; maxGuests: number | null; sqft: number | null },
  existing: { bedrooms: number | null; bathrooms: number | null; max_guests: number | null; square_footage: number | null },
): TablesUpdate<'properties'> {
  const patch: TablesUpdate<'properties'> = {}
  if (orData.bedrooms  !== null && existing.bedrooms       === null) patch.bedrooms       = orData.bedrooms
  if (orData.bathrooms !== null && existing.bathrooms      === null) patch.bathrooms      = orData.bathrooms
  if (orData.maxGuests !== null && existing.max_guests     === null) patch.max_guests     = orData.maxGuests
  if (orData.sqft      !== null && existing.square_footage === null) patch.square_footage = orData.sqft
  return patch
}

type StepLogger = { info: (msg: string) => void; warn: (msg: string) => void }

interface BookingRevenueTarget {
  bookingId:         string
  propertyId:        string
  actualTotalAmount: number | null
}

interface FetchBookingsResult {
  cursor:                string
  count:                 number
  affectedPropertyIds:   string[]
  bookingsToPostRevenue: BookingRevenueTarget[]
  historyFrom:           string
}

/**
 * writeSyncCount plus its non-fatal failure handling, which both exits of
 * fetch-bookings need.
 *
 * The count is a progress figure the connect screen polls; failing to record it
 * must not fail a sync whose bookings already landed. It was open-coded
 * identically on both paths, and a swallowed error is exactly the kind of thing
 * that drifts between two copies.
 */
async function recordBookingsFound(
  userId: string,
  count:  number,
  logger: StepLogger,
): Promise<void> {
  try {
    await writeSyncCount(userId, 'bookings_found', count)
  } catch (countErr) {
    logger.warn(
      `[OwnerRez:${userId}] writeSyncCount bookings_found failed: ${countErr instanceof Error ? countErr.message : String(countErr)}`
    )
    reportError(countErr, { site: 'inngest.ownerrez-initial-sync.fetch-bookings' })
  }
}

/**
 * Maps OwnerRez bookings onto FieldStay property ids and upserts them.
 *
 * Extracted whole because it is the one part of fetch-bookings that can fail in
 * a way the caller must not paper over: if the property lookup fails, every row
 * would carry property_id null and the upsert would overwrite good rows with
 * nulls. That throw is the point of the function, so it reads better as its own
 * unit than as the deep branch of a step callback.
 */
async function persistInitialBookings(params: {
  orgId:       string
  userId:      string
  bookings:    OwnerRezBooking[]
  externalIds: number[]
  logger:      StepLogger
}): Promise<{ affectedPropertyIds: string[]; bookingsToPostRevenue: BookingRevenueTarget[] }> {
  const { orgId, userId, bookings, externalIds, logger } = params
  const supabase = createServiceClient({ system: 'inngest:initial-sync' })

  const { data: fsProps, error: propsLookupError } = await supabase
    .from('properties')
    .select('id, external_id')
    .eq('org_id', orgId)
    .eq('external_source', PROVIDER)
    .in('external_id', externalIds.map(String))
    // One row per external id — same reasoning as incremental-sync.
    .limit(externalIds.length)

  if (propsLookupError || !fsProps) {
    console.error(
      `[OwnerRez sync] Property lookup failed for org ${orgId} — ` +
      `skipping booking upsert to prevent property_id null overwrite`,
      propsLookupError?.message
    )
    throw new Error(
      `Property lookup failed for org ${orgId}: ${propsLookupError?.message ?? 'unknown error'}`
    )
  }

  const externalToFsId = Object.fromEntries(fsProps.map((p) => [p.external_id, p.id]))

  const builtRows = bookings.map((b) => buildOwnerRezBookingRow(orgId, b, externalToFsId))
  const { mapped: bookingRows, unmappedCount } = partitionMappedBookingRows(builtRows)

  if (unmappedCount) {
    logger.warn(
      `[OwnerRez:${userId}] skipping ${unmappedCount} booking(s) whose OwnerRez property has no FieldStay property`
    )
  }

  // Chunked, and this is the sync where it matters most: a portfolio with
  // history clears max_rows = 1000 on its FIRST run — the one whose job is to
  // get the historical owner ledger right. A truncated representation there
  // silently omitted revenue for every booking past the first 1000. See
  // upsert-bookings.ts.
  const idByExternalId = await upsertBookingsReturningIds(
    supabase, bookingRows, `OwnerRez:${userId}`)

  logger.info(`[OwnerRez:${userId}] Upserted ${bookingRows.length} bookings`)

  return {
    affectedPropertyIds: Array.from(new Set(
      bookingRows.map((b) => b.property_id).filter((id): id is string => id !== null)
    )),
    // Revenue floor: current month onward only. A stay that completed before
    // the account connected has no cleaning fee, work order or restock recorded
    // against it, because none of those happened in FieldStay. Its revenue
    // alone is not a P&L, it is an overstatement.
    bookingsToPostRevenue: selectOwnerRezBookingsToPostRevenue(
      bookingRows, idByExternalId, revenuePostingFloor(new Date())),
  }
}

export const ownerRezInitialSync = inngest.createFunction(
  {
    id:      'ownerrez-initial-sync',
    name:    'OwnerRez Initial Sync',
    retries: 3,
    // Two caps, and they answer different questions.
    //
    // The unkeyed one is capacity: this is the heaviest OwnerRez consumer we
    // have — it paginates every property, listing and booking for a brand-new
    // account — and the 300-request/5-minute OwnerRez budget is shared by every
    // tenant on the same deployment IP. Left uncapped, several signups landing
    // together would spend that budget on each other and take the incremental
    // syncs down with them. 3 matches ownerRezConnectionSync's cap for the
    // same reason.
    //
    // The keyed one is correctness: never two initial syncs for one connection
    // at once. This step chain seeds checklists, generates turnovers and seeds
    // assets from amenities, and not all of that is safe to interleave with
    // itself. A reconnect, a double-clicked Connect button, or a re-fired
    // event would otherwise race. Keyed concurrency QUEUES the second run
    // rather than dropping it, which is what a genuine reconnect wants —
    // `idempotency` would silently discard it instead.
    concurrency: [
      { limit: 3 },
      { limit: 1, key: 'event.data.user_id' },
    ],
  },
  { event: 'integration/ownerrez.connected' as const },
  async ({ event, step, logger }) => {
    const { user_id, org_id } = event.data
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
          reportError(countErr, { site: 'inngest.ownerrez-initial-sync.fetch-properties' })
        }

        if (!properties.length) return { ids: [] as number[], patchData: [] as typeof patchData }

        const patchData = properties.map((p) => ({
          externalId: String(p.id),
          bedrooms:   p.bedrooms,
          bathrooms:  p.bathrooms,
          maxGuests:  p.max_occupancy,
          // ✅ Confirmed live 2026-07-15 — living_area is the real field;
          // the previous sqft/square_feet/size fallback chain was never
          // real and always resolved to null.
          sqft:       p.living_area ?? null,
        }))

        const supabase = createServiceClient({ system: 'inngest:initial-sync' })
        // bedrooms/bathrooms/max_guests are deliberately absent: patch-property-
        // fields (step 1b, immediately below) writes them, and writes them ONLY
        // where FieldStay currently holds null. Naming them here re-asserted
        // OwnerRez's value on every re-run and silently undid a PM's manual
        // correction one step before buildNullFillPatch declined to — the
        // regression that function's `!== null` checks were written to prevent
        // was being caused upstream of it.
        const rows: TablesInsert<'properties'>[] = properties.map((p) => ({
          org_id,
          name:            p.name,
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
          .upsert(rows, { onConflict: 'org_id,external_id,external_source' })

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

        const supabase    = createServiceClient({ system: 'inngest:initial-sync' })
        const externalIds = fetchPropsResult.patchData.map((p) => p.externalId)

        const existingPropsRes = await supabase
          .from('properties')
          .select('id, external_id, bedrooms, bathrooms, max_guests, square_footage')
          .eq('org_id', org_id)
          .eq('external_source', PROVIDER)
          .in('external_id', externalIds)
          .limit(externalIds.length)
        const existingProps = unwrapList(existingPropsRes, {
          site:  'inngest.ownerrez-initial-sync.patch-property-fields',
          orgId: org_id,
        })

        if (!existingProps.length) return

        // MEDIUM-2: collect patch failures rather than silently swallowing them
        const failures: string[] = []

        for (const existing of existingProps) {
          const orData = fetchPropsResult.patchData.find((p) => p.externalId === existing.external_id)
          if (!orData) continue

          const patch = buildNullFillPatch(orData, existing)

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
        const supabase = createServiceClient({ system: 'inngest:initial-sync' })
        const res = await supabase
          .from('properties')
          .select('id, external_id, wifi_name, wifi_password, access_instructions, house_manual, amenities')
          .eq('external_source', PROVIDER)
          .eq('org_id', org_id)
          .eq('is_active', true)
          .limit(500)
        return unwrapList(res, {
          site:  'inngest.ownerrez-initial-sync.fetch-properties-to-enrich',
          orgId: org_id,
        }) as EnrichTarget[]
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
          reportError(err, { site: 'inngest.ownerrez-initial-sync.fetch-listings-batch' })
          return {} as Record<string, OwnerRezListing>
        }
      })

      // Step 1c-iii: one memoized step per property for the detail call + patch.
      for (const dbProp of enrichTargets) {
        await step.run(`fetch-property-detail-${dbProp.id}`, async () => {
          const supabase = createServiceClient({ system: 'inngest:initial-sync' })
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

      // Fanned out the same way as Step 1c-iii above: a single memoized step
      // determines which properties still need the default template, then one
      // memoized step per property applies it — so a retry only redoes the
      // properties that hadn't been applied yet, not the whole batch.
      const propertiesNeedingChecklist = await step.run('find-properties-needing-checklist', async () => {
        if (!fetchPropsResult.patchData.length) return []

        const supabase    = createServiceClient({ system: 'inngest:initial-sync' })
        const externalIds = fetchPropsResult.patchData.map((p) => p.externalId)

        // Paginated and error-bound. A failed read returned null,
        // `!properties?.length` short-circuited to [], and every property this
        // sync just created silently never got a checklist — a turnover with
        // no checklist for the crew to work from, reported as a clean sync.
        // A max_rows truncation produces the same outcome for the properties
        // past the cap, which is why bounding the error alone is not enough.
        // fetchAllRows throws on a page error, so the step gets a retry.
        const properties = await fetchAllRows<{ id: string }>(
          (from, to) => supabase
            .from('properties')
            .select('id')
            .eq('org_id', org_id)
            .eq('external_source', PROVIDER)
            .in('external_id', externalIds)
            .order('id', { ascending: true })
            .range(from, to),
          { label: `properties-needing-checklist(ownerrez)[org=${org_id}]` },
        )

        if (!properties.length) return []

        // Filter to properties without an existing default template.
        //
        // Also bounded, though this one errs the other way: a failure (or a
        // truncated page) made `hasTemplate` short, so properties that already
        // had a default template looked like they needed one.
        // applyMasterChecklistToProperty's own force:false guard absorbs that
        // (it re-checks per property and returns early), so the cost was
        // wasted work rather than duplicates — but that guard is the only
        // thing standing between this and duplicate default templates, and it
        // had the identical discarded-error defect until this same change.
        // property_id is nullable on checklist_templates (an org-level
        // template has none); only the property-scoped rows matter here and
        // the .in() filter already excludes the rest, but the generated type
        // still says string | null, so the Set is built from the non-nulls.
        const existingTemplates = await fetchAllRows<{ property_id: string | null }>(
          (from, to) => supabase
            .from('checklist_templates')
            .select('property_id')
            .eq('org_id', org_id)
            .eq('is_default', true)
            .in('property_id', properties.map((p) => p.id))
            .order('property_id', { ascending: true })
            .range(from, to),
          { label: `existing-default-templates(ownerrez)[org=${org_id}]` },
        )

        const hasTemplate = new Set(
          existingTemplates
            .map((t) => t.property_id)
            .filter((id): id is string => id !== null)
        )
        return properties
          .filter((p) => !hasTemplate.has(p.id as string))
          .map((p) => p.id as string)
      })

      // Seeded + fetched once for the whole sync run, not once per
      // property — applyMasterChecklistToProperty's default behavior is
      // to re-fetch the org's seed-check/mapping/room-templates/items on
      // every call, which is identical data for every property being
      // synced here. Only bothers with either step when there's actually
      // at least one property that needs it.
      let ownerRezOrgRoomData: OrgRoomTemplateData | undefined

      if (propertiesNeedingChecklist.length > 0) {
        await step.run('seed-room-templates', async () => {
          await seedDefaultRoomTemplatesIfNeeded(org_id)
        })

        ownerRezOrgRoomData = await step.run('fetch-room-template-data', async () => {
          const supabase = createServiceClient({ system: 'inngest:initial-sync' })
          return fetchOrgRoomTemplateData(org_id, supabase)
        })
      }

      for (const propertyId of propertiesNeedingChecklist) {
        await step.run(`apply-checklist-${propertyId}`, async () => {
          const supabase = createServiceClient({ system: 'inngest:initial-sync' })
          await applyMasterChecklistToProperty(propertyId, org_id, supabase, {
            force:       false,
            actorId:     user_id,
            orgRoomData: ownerRezOrgRoomData,
            skipSeed:    true,
          })
        })
      }

      logger.info(
        `[OwnerRez:${user_id}] Applied master checklist to ${propertiesNeedingChecklist.length} properties`
      )

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
          reportError(err, { site: 'inngest.ownerrez-initial-sync.seed-asset-discovery-from-amenities' })
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
          reportError(err, { site: 'inngest.ownerrez-initial-sync.seed-present-assets-from-amenities' })
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
          reportError(err, { site: 'inngest.ownerrez-initial-sync.create-guidebook-property-configs' })
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

      const fetchBookingsResult: FetchBookingsResult =
        await step.run('fetch-bookings', async () => {
          // No properties means nothing to ask OwnerRez about. Still record the
          // zero so the connect screen stops waiting on a count that never comes.
          if (!fetchPropsResult.ids.length) {
            await recordBookingsFound(user_id, 0, logger)
            return {
              cursor:                new Date().toISOString(),
              count:                 0,
              affectedPropertyIds:   [],
              bookingsToPostRevenue: [],
              historyFrom:           initialHistoryFrom(new Date()),
            }
          }

          // MEDIUM-3: capture the cursor BEFORE the fetch. A post-fetch
          // timestamp would skip anything modified during the fetch window,
          // which runs 30-90 seconds for a large tenant.
          const fetchStartedAt = new Date().toISOString()

          // BOUNDED to a recent window, plus everything upcoming.
          //
          // This call used to pass no date bounds at all — "every booking this
          // account has ever had" — which was survivable only because the pager
          // stopped at 20 records. Older history is walked backwards afterwards,
          // one window per incremental sync (ownerrez-backfill.ts).
          //
          // `from` with no `to` is the important shape: `from` means "departs on
          // or after", so every FUTURE booking is still included. Bounding the
          // upper end would drop upcoming stays, which are the whole point of a
          // first sync.
          const historyFrom = initialHistoryFrom(new Date(fetchStartedAt))

          const bookings = await client.getBookings({
            propertyIds:  fetchPropsResult.ids,
            from:         historyFrom,
            includeGuest: true,
          })

          const persisted = bookings.length
            ? await persistInitialBookings({
                orgId:       org_id,
                userId:      user_id,
                bookings,
                externalIds: fetchPropsResult.ids,
                logger,
              })
            : { affectedPropertyIds: [], bookingsToPostRevenue: [] }

          await recordBookingsFound(user_id, bookings.length, logger)

          return { cursor: fetchStartedAt, count: bookings.length, historyFrom, ...persisted }
        })

      // ── Post booking revenue for newly-confirmed guest-stay bookings ───────
      // Mirrors Hospitable's incremental-sync pattern: sendEvent happens in the
      // outer function body, never nested inside step.run. actual_total_amount
      // is now sourced from charges[].owner_amount (or total_amount/total_owed
      // as fallback) via extractOwnerRezActualTotal — confirmed live
      // 2026-07-15; booking-events.ts's handleBookingConfirmed still falls
      // back to the avg_nightly_rate estimate whenever this is null (e.g. a
      // booking whose charges genuinely didn't resolve to a positive total).
      // BATCHED, one step per chunk rather than one step per booking.
      //
      // This was `for (const b of ...) await step.sendEvent(...)`, which makes
      // a distinct Inngest step — with its own memoized state carried for the
      // rest of the run — for every single booking. At 20 bookings that was
      // invisible; bounded to a 90-day window it is hundreds, and unbounded it
      // would have been thousands once pagination started working. step.sendEvent
      // takes an array, so a chunk costs one step regardless of its size.
      const revenueEvents = fetchBookingsResult.bookingsToPostRevenue.map((b) => ({
        name: 'booking/confirmed' as const,
        data: {
          booking_id:          b.bookingId,
          property_id:         b.propertyId,
          org_id,
          source:              'ownerrez' as const,
          actual_total_amount: b.actualTotalAmount,
        },
      }))

      for (let i = 0; i < revenueEvents.length; i += REVENUE_EVENT_CHUNK) {
        const chunk = revenueEvents.slice(i, i + REVENUE_EVENT_CHUNK)
        // Chunk index, not booking id: the step id must stay stable across
        // retries, and it does because the source list is memoized upstream.
        await step.sendEvent(`post-booking-revenue-${i / REVENUE_EVENT_CHUNK}`, chunk)
      }

      // ── Step 3: Update sync metadata ────────────────────────────────────────

      await step.run('update-last-synced', async () => {
        // MEDIUM-2: throw on cursor failure — a stale cursor causes full re-syncs
        try {
          await mergeIntegrationConnectionMetadata({
            userId:     user_id,
            providerId: PROVIDER,
            patch: {
              sync_cursor:      fetchBookingsResult.cursor,
              last_synced_at:   new Date().toISOString(),
              last_sync_status: 'success',
              last_sync_error:  null,
              last_sync_count:  fetchBookingsResult.count,
              // Seeds the historical backfill walk at the exact lower edge of
              // the window this run actually fetched — NOT at "90 days before
              // whenever the first backfill happens to run". Recomputing it
              // later would open a gap the width of the delay between the two,
              // and nothing ever revisits a skipped window.
              backfill_oldest_covered: fetchBookingsResult.historyFrom,
              backfill_complete:       false,
            },
          })
        } catch (err) {
          throw new Error(`[OwnerRez:${user_id}] Failed to persist sync cursor: ${err instanceof Error ? err.message : String(err)}`)
        }
      })

      // ── Step 4: Generate turnovers for synced properties ─────────────────────
      // Called once per property (not per booking) so the generator sees the
      // full booking list and can apply its two-pass pairing logic correctly.

      const newTurnoverIds = await step.run('generate-turnovers', async () => {
        const propertyIds = fetchBookingsResult.affectedPropertyIds
        if (!propertyIds.length) return []
        const supabase = createServiceClient({ system: 'inngest:initial-sync' })
        const ids: string[] = []
        for (const propertyId of propertyIds) {
          try {
            const newIds = await generateTurnoversForProperty(propertyId, org_id, supabase)
            ids.push(...newIds)
          } catch (err) {
            logger.error(
              `[OwnerRez:${user_id}] Turnover generation failed for property ${propertyId}: ${err}`
            )
            reportError(err, { site: 'inngest.ownerrez-initial-sync.generate-turnovers' })
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
    } catch (err) {
      const humanError = translateSyncError(err)
      logger.error(
        `[OwnerRez:${user_id}] initial sync failed: ${err instanceof Error ? err.message : String(err)}`
      )
      reportError(err, { site: 'inngest.ownerrez-initial-sync.fetch-new-turnover-data' })

      // Returns the connection id when a PM notification is DUE, or null.
      const notifyConnectionId = await step.run('handle-sync-failure', async () => {
        const supabase = createServiceClient({ system: 'inngest:initial-sync' })
        const isRevoked = err instanceof TokenRevokedError

        const existingRes = await supabase
          .from('integration_connections')
          .select('id')
          .eq('user_id', user_id)
          .eq('provider_id', PROVIDER)
          .maybeSingle()
        const existingOut = tryUnwrap(existingRes, {
          site:  'inngest.ownerrez-initial-sync.handle-sync-failure',
          orgId: org_id,
        })
        const existing = existingOut.ok ? existingOut.data : null

        await mergeIntegrationConnectionMetadata({
          userId:     user_id,
          providerId: PROVIDER,
          patch: {
            last_sync_status: 'error',
            last_sync_error:  humanError,
            last_synced_at:   new Date().toISOString(),
          },
          status: isRevoked ? 'revoked' : 'error',
        })

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

        // Decide whether a PM notification is due — throttled to once per 4
        // hours per connection. Revoked tokens are the most important case to
        // notify on: only the PM can fix them by reconnecting, and they never
        // self-resolve on retry.
        //
        // Decision ONLY; the send happens at the top level below. See the
        // block comment there.
        if (!existing?.id) return null
        const due = await shouldNotifyConnectionError(supabase, {
          orgId:        org_id,
          connectionId: existing.id,
          site:         'inngest.ownerrez-initial-sync.handle-sync-failure.throttle',
        })
        return due ? existing.id : null
      })

      // The send is HERE, at the top level, not inside handle-sync-failure.
      // It used to sit inside that step.run. Inngest does not support nested
      // step tooling: it warns rather than throws (NESTING_STEPS), then
      // unwinds the request so the nested op can be scheduled, which leaves
      // the enclosing step.run unresolved. Its callback then re-ran from the
      // top on the next pass — re-emitting the integration.sync_failed audit
      // event above, an un-deduped insert. Every failed initial sync that
      // notified wrote two audit rows.
      //
      // It also has to run BEFORE the throws below, or the notification the
      // PM needs most (a revoked token) would never be sent.
      // See lib/integrations/connection-error-notify.ts.
      if (notifyConnectionId) {
        await step.sendEvent('notify-connection-error', {
          name: 'integration/connection.error',
          data: {
            user_id:     user_id,
            org_id:      org_id,
            provider_id: PROVIDER,
            reason:      humanError,
          },
        })

        // Its own step, deliberately: a failure here retries just this write,
        // with the send already memoized, so it can neither duplicate the
        // notification nor replay the audit event.
        await step.run('record-connection-error-notified', async () => {
          const supabase = createServiceClient({ system: 'inngest:initial-sync' })
          await recordConnectionErrorNotified(supabase, {
            orgId:        org_id,
            connectionId: notifyConnectionId,
            site:         'inngest.ownerrez-initial-sync.handle-sync-failure.record-notified',
          })
        })
      }

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

    // REMOVED: the 'auto-activate-repuguard' step. RepuGuard ships with every
    // plan and nothing gates on organizations.repuguard_status any more, so
    // activating it on OwnerRez connect is a no-op. It is worth naming why it
    // existed: this step was the ONLY thing that ever moved the column off its
    // 'inactive' default, which is exactly why every org that had not connected
    // OwnerRez was locked out of a feature included in their plan.

    // Webhook delivery is NOT registered per-connection via the API — confirmed
    // 2026-07-16 against the live OwnerRez dashboard: the URL, Basic Auth
    // credentials, and enabled entity types (Booking, Guest) are configured
    // once at the OAuth app level (Developer/API settings → Webhooks), and
    // OwnerRez applies that config automatically to every connected user.
    // The removed step here used to POST to /v2/webhooksubscriptions per
    // sync trying to recreate that config — an operation that was never
    // valid (confirmed 400 on every attempt for weeks) and, even if it had
    // succeeded, would have been entirely redundant with the dashboard
    // config that already covers this.

    return { user_id, synced: true }
  }
)
