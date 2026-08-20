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
// Org + token resolution goes through resolveHospitableOwner() (see
// hospitable-owner.ts) — never pick an active connection directly here.
//
// Structure: the exported function is a ROUTER — it validates the provider,
// then dispatches to one per-entity handler defined below. Each handler owns
// its own step.run() calls and receives `step`; exactly one handler runs per
// invocation, so step ids remain unique within a run.
// ============================================================

import { inngest }                 from '@/lib/inngest/client'
import type { GetStepTools }       from 'inngest'
import { NonRetriableError }       from 'inngest'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { createServiceClient }     from '@/lib/supabase/server'
import { resolveHospitableOwner, type HospitableEntityKind } from '@/lib/integrations/providers/hospitable-owner'
import {
  hospitableFetch,
  hospitablePropertyToNormalized,
  hospitableReservationToNormalized,
  type HospitableReservation,
  type HospitableProperty,
} from '@/lib/integrations/providers/hospitable'
import { upsertNormalizedProperties } from '@/lib/properties/upsert-normalized'
import { generateTurnoversForProperty, cancelTurnoversForBooking, notifyCrewOfCancelledTurnovers } from '@/lib/turnovers/generator'
import {
  createGuidebookPropertyConfigsForProperties,
  syncGuidebookConfigsFromProperty,
} from '@/lib/guidebook/sync'
import {
  seedPresentAssetsFromAmenities,
  seedAbsentOptionalAssetsFromAmenities,
} from '@/lib/asset-discovery/seed-from-amenities'

import { reportError } from '@/lib/observability/report-error'
import { unwrap } from '@/lib/supabase/unwrap'
import { RateLimitError, ProviderAuthError, ProviderRequestError } from '@/lib/integrations/types'
import { isUuid } from '@/lib/validation/uuid'
const HOSPITABLE_API_BASE = 'https://public.api.hospitable.com/v2'
const PROVIDER            = 'hospitable'

/** What a throttled attempt returns instead of throwing. See withProviderCall. */
interface RateLimitedOutcome { __rateLimited: true; retryAfter: number }

function isRateLimited(value: unknown): value is RateLimitedOutcome {
  return typeof value === 'object' && value !== null && '__rateLimited' in value
}

/**
 * Runs one provider-touching step with the two failure modes Hospitable
 * actually produces handled explicitly, instead of both falling through to
 * Inngest's generic retry policy.
 *
 * Background — the 2026-08-17 incident. Three separate comments in
 * hospitable.ts and hospitable-owner.ts ASSERTED this function already did
 * this ("the caller ... is set up to step.sleep and retry"). It did not: there
 * was no RateLimitError handling and no step.sleep anywhere in this file. So:
 *
 *   - A 429 became a step failure, retried on Inngest's exponential backoff,
 *     which is not aligned to Retry-After and re-runs the WHOLE step —
 *     including, for the resolution step, re-probing EVERY candidate
 *     connection. A rate-limit failure therefore issued MORE provider calls on
 *     retry than the attempt that failed. Hospitable's own partner API log
 *     showed the result: three GETs on one reservation inside 48 seconds, the
 *     middle one a 429.
 *   - A 401 on the messages endpoint burned all 5 retries and surfaced as
 *     "exhausted all retries" in Sentry, five doomed calls against an API that
 *     was rate-limiting us in the same minute.
 *
 * Both are fixed at the same place because they were the same mistake — letting
 * the retry policy decide something the error type already knew.
 *
 * ⚠️ Why RateLimitError is RETURNED rather than thrown and caught outside:
 * Inngest surfaces a step's error to surrounding code only AFTER that step has
 * exhausted the function's retries. A try/catch around step.run therefore
 * cannot prevent the retry storm — it observes it after the fact. Returning a
 * decision from inside the step and doing the step tooling at the top level is
 * the pattern CLAUDE.md prescribes for exactly this reason, and it is what
 * makes the sleep happen INSTEAD of the retries rather than after them.
 * (hospitable-reviews-backfill.ts's outer-catch version has the same latent
 * gap; it is not on this incident's path and is left for its own change.)
 *
 * One extra attempt, not a loop: if honouring the provider's own interval still
 * isn't enough, the budget is genuinely gone and Inngest's retries are the
 * right next layer — so the second throttle is rethrown.
 */
async function withProviderCall<T>(
  step: SyncStep,
  id:   string,
  run:  () => Promise<T>,
): Promise<T> {
  const attempt = async (): Promise<T | RateLimitedOutcome> => {
    try {
      return await run()
    } catch (err) {
      // Terminal: a missing scope or a revoked grant. Retrying cannot change
      // the answer, so opt this step out of the retry policy entirely.
      if (err instanceof ProviderAuthError) throw new NonRetriableError(err.message)
      // Terminal for the mirror-image reason: a malformed request. The retry
      // rebuilds the same URL from the same event payload.
      if (err instanceof ProviderRequestError) throw new NonRetriableError(err.message)
      if (err instanceof RateLimitError)    return { __rateLimited: true, retryAfter: err.retryAfter }
      throw err
    }
  }

  const first = await step.run(id, attempt) as T | RateLimitedOutcome
  if (!isRateLimited(first)) return first

  await step.sleep(`${id}-rate-limit-sleep`, `${first.retryAfter}s`)

  const second = await step.run(`${id}-retry`, attempt) as T | RateLimitedOutcome
  if (!isRateLimited(second)) return second

  throw new RateLimitError(second.retryAfter)
}

/** The shape every branch's skip path returns. */
function noActiveConnection(entityId: string) {
  return { skipped: true, reason: 'no_active_connection', entity_id: entityId }
}

/**
 * Resolves the org and a token for one entity, or null when no connected
 * account owns it.
 *
 * The reservation and review branches had this written out identically — 18
 * duplicated lines differing only in `entityKind` and one word of the log
 * message (SonarQube flagged it as self-duplication within this file). That is
 * three places for one contract to drift: "no owner resolved" must SKIP, never
 * fall through to a fetch with an arbitrary connection's token, which is the
 * misattribution hazard resolveHospitableOwner exists to prevent.
 *
 * syncProperty keeps its own copy on purpose — it additionally computes
 * isNewProperty against the resolved org inside the same step, and folding
 * that in would mean a parameter that only one caller ever uses.
 */
async function resolveOwnerOrSkip(
  step:           SyncStep,
  logger:         SyncLogger,
  entityKind:     HospitableEntityKind,
  entityId:       string,
  externalUserId: string | undefined,
): Promise<{ orgId: string; token: string } | null> {
  const resolved = await withProviderCall(step, 'resolve-org-and-token', async () => {
    const owner = await resolveHospitableOwner({ entityKind, externalId: entityId, externalUserId })
    if (!owner) return { skipped: true as const }
    return { skipped: false as const, orgId: owner.orgId, token: owner.token }
  })

  if (resolved.skipped) {
    logger.info(`[Hospitable incremental] Skipping ${entityKind} ${entityId} — no active Hospitable connection`)
    return null
  }

  return { orgId: resolved.orgId, token: resolved.token }
}

// Reservation `triggers` values that don't correspond to anything
// NormalizedBooking/the `bookings` table stores:
//   guests_changed        → guest counts, we don't store these (only guest name/email)
//   notes_changed         → internal conversation notes, not synced
//   guest_issue_detected  → issue_alert field, not synced
// Deliberately NOT included (so they still trigger a re-fetch): status_changed,
// dates_changed, checkin_changed, checkout_changed (all map directly to
// columns we write), listing_changed (could mean the reservation moved
// to a different property — safer to re-fetch and re-resolve than assume),
// and financials_changed — REMOVED from this set 2026-07-10: it used to be
// genuinely irrelevant (financials:read wasn't granted, nothing consumed
// it), but bookings.actual_total_amount now depends on it. A live webhook
// caught by this exact skip during initial testing (a reservation.created
// event carrying only financials_changed) confirmed keeping it here would
// silently defeat the whole feature — every financials update would be
// skipped before ever reaching the fetch that reads it.
const IRRELEVANT_RESERVATION_TRIGGERS = new Set([
  'guests_changed',
  'notes_changed',
  'guest_issue_detected',
])

export const hospIncrementalSync = inngest.createFunction(
  {
    id:          'hospitable-incremental-sync',
    name:        'Hospitable: Incremental Sync',
    // 5 retries (was 3): the ownership probe in resolveHospitableOwner() can
    // hit hospitableApiLimiter's shared platform budget during a concurrent
    // initial sync. The probe memoizes its result, so a retry is cheap — but
    // exhausting the budget must not permanently drop a real webhook.
    retries:     5,
    // Per-entity concurrency prevents duplicate work on the same id. The
    // first, unkeyed limit is a PLATFORM cap: without it, 100 orgs' webhooks
    // fan out unbounded against one shared Hospitable rate-limit budget.
    //
    // The per-entity limit is 1, not 2. At 2 this comment was simply false —
    // two invocations for ONE reservation ran simultaneously, each doing its
    // own ownership probe and its own fetch. GET /reservations/{id}/messages
    // is capped by Hospitable at 2 requests/minute PER RESERVATION, so a
    // single pair of concurrent invocations could spend that entire minute's
    // budget before any retry was involved, and duplicate work was exactly
    // what the second slot bought. Hospitable's partner API log on 2026-08-17
    // showed three GETs on one reservation inside 48 seconds with a 429 in the
    // middle. There is no throughput argument for the second slot: the two
    // invocations are racing to write the same row.
    concurrency: [
      { limit: 8 },
      { limit: 1, key: 'event.data.entity_id' },
    ],
  },
  { event: 'integration/hospitable.sync.requested' as const },
  async ({ event, step, logger }) => {
    const { provider_id, event_type, entity_type, entity_id, triggers, external_user_id } = event.data

    if (provider_id !== PROVIDER) {
      logger.warn(`[Hospitable incremental] Unexpected provider_id: ${provider_id}`)
      return { skipped: true, reason: 'wrong_provider' }
    }

    logger.info(`[Hospitable incremental] ${event_type} / ${entity_type} / ${entity_id}`)

    // Every entity Hospitable exposes is keyed by a UUID, and every branch
    // below spends it in two places: a resolveHospitableOwner() call and a
    // /v2/{collection}/{uuid} URL. A non-UUID makes both meaningless, and the
    // resolver reaches the SECOND one only after the first has already written
    // a row — resolveHospitableOwner's step-0 direct attribution (the webhook
    // carries the account's own user.id) calls rememberOwner() unconditionally,
    // so a bogus id is CACHED as a real reservation before anything validates
    // it. Two such rows were left in integration_entity_owners on 2026-08-20.
    //
    // NonRetriableError rather than a returned skip: the event is malformed at
    // rest, so every one of the 5 retries would re-derive the same verdict.
    if (!isUuid(entity_id)) {
      const detail = `${entity_type} id is not a UUID (${typeof entity_id}): ${JSON.stringify(entity_id)}`
      logger.error(`[Hospitable incremental] Dropping ${event_type} — ${detail}`)
      throw new NonRetriableError(`[Hospitable incremental] ${detail}`)
    }

    const ctx = { step, logger, entityId: entity_id, externalUserId: external_user_id }

    if (entity_type === 'reservation') return syncReservation({ ...ctx, triggers })
    if (entity_type === 'property')    return syncProperty(ctx)
    if (entity_type === 'review')      return syncReview(ctx)
    // 'message' is gone: the webhook now writes the row itself, because its
    // payload already contains the whole message (see
    // lib/integrations/providers/hospitable-message-store.ts). An in-flight
    // event from before that change lands in the unhandled branch below and is
    // logged — it cannot be usefully replayed anyway, since the fetch it
    // wanted is what was broken.

    logger.warn(`[Hospitable incremental] Unhandled entity_type: ${entity_type}`)
    return { skipped: true, reason: `unknown_entity_type:${entity_type}` }
  }
)


// ── Per-entity handlers ─────────────────────────────────────────────────────
//
// One of these runs per invocation, selected by the router above. They are
// separate functions rather than branches of one 700-line handler so each
// entity's flow — and its failure contract — can be read on its own.

type SyncStep   = GetStepTools<typeof inngest>
type SyncLogger = {
  info:  (msg: string) => void
  warn:  (msg: string) => void
  error: (msg: string) => void
}

interface EntityContext {
  step:           SyncStep
  logger:         SyncLogger
  entityId:       string
  externalUserId: string | undefined
}

/**
 * Reservation: upsert the booking, then react to what changed — a 404 or a
 * 'cancelled' status cancels its turnovers and notifies crew; changed dates
 * regenerate them; a confirmed guest stay posts booking revenue.
 */
async function syncReservation(
  { step, logger, entityId, externalUserId, triggers }: EntityContext & { triggers: string[] | undefined }
) {

  // Hospitable's `triggers` array names what changed. If every trigger
  // present is one FieldStay doesn't store anything for, skip the
  // re-fetch entirely rather than hitting the API for no reason.
  // Absent (e.g. reservation.created has none) or containing anything
  // outside this set proceeds normally — this is an efficiency skip
  // only, never the basis for deciding what actually changed once we
  // do fetch (that's still the before/after date comparison below).
  if (triggers?.length && triggers.every((t) => IRRELEVANT_RESERVATION_TRIGGERS.has(t))) {
    logger.info(`[Hospitable incremental] Skipping ${entityId} — only irrelevant triggers: ${triggers.join(', ')}`)
    return { action: 'skipped', reason: 'irrelevant_trigger', entity_id: entityId, triggers }
  }

  // Ownership is resolved by resolveHospitableOwner(), never by picking an
  // active connection here. Hospitable's webhooks carry no account id, so
  // "any active connection" silently misattributes every new reservation
  // once a second org is connected. See hospitable-owner.ts.
  const resolved = await resolveOwnerOrSkip(step, logger, 'reservation', entityId, externalUserId)
  if (!resolved) return noActiveConnection(entityId)

  const { orgId, token } = resolved

  const reservation = await withProviderCall(step, 'fetch-reservation', async () => {
    // financials is speculative — gated on the not-yet-granted
    // financials:read scope, see HospitableReservation.financials.
    const res = await hospitableFetch(
      `${HOSPITABLE_API_BASE}/reservations/${entityId}?include=guest,properties,financials`,
      token
    )

    if (res.status === 404) return null

    if (!res.ok) {
      throw new Error(
        `Hospitable GET /reservations/${entityId} failed: HTTP ${res.status}`
      )
    }

    const data = await res.json() as { data: HospitableReservation }
    return data.data
  })

  if (!reservation) {
    const cancelledBookingId = await step.run('mark-cancelled', async () => {
      const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
      const { data: cancelled, error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('external_id',     entityId)
        .eq('external_source', PROVIDER)
        .eq('org_id',          orgId)
        .select('id')
        .maybeSingle()

      if (error) throw new Error(`mark-cancelled failed: ${error.message}`)
      return cancelled?.id ?? null
    })

    if (cancelledBookingId) {
      const cancelledAssignments = await step.run('cancel-turnovers-for-deleted-reservation', async () => {
        const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
        return cancelTurnoversForBooking(cancelledBookingId, supabase)
      })

      await step.run('notify-crew-deleted-reservation', async () => {
        await notifyCrewOfCancelledTurnovers(cancelledAssignments)
      })
    }

    logger.info(`[Hospitable incremental] Reservation ${entityId} cancelled`)
    return { action: 'cancelled', entity_id: entityId }
  }

  const upsertResult = await step.run('upsert-booking', async () => {
    const supabase       = createServiceClient({ system: 'inngest:incremental-sync' })
    // Confirmed from the official Hospitable webhook spec: 'properties'
    // is an array[Property], not a singular 'property' object.
    const hospPropertyId = reservation.properties?.[0]?.id ?? null

    if (!hospPropertyId) {
      throw new NonRetriableError(
        `Reservation ${entityId} has no property reference in Hospitable response`
      )
    }

    // Unwrapped so the thrown error names the real cause. Both outcomes retry,
    // but a failed read used to surface as "Property … not in FieldStay",
    // sending whoever reads it to look for a missing property sync.
    const propertyRes = await supabase
      .from('properties')
      .select('id')
      .eq('org_id',          orgId)
      .eq('external_id',     hospPropertyId)
      .eq('external_source', PROVIDER)
      .maybeSingle()

    const property = unwrap(propertyRes, {
      site: 'inngest.hospitable-incremental.booking-property', orgId,
    })

    if (!property) {
      throw new Error(
        `Property ${hospPropertyId} not in FieldStay — ` +
        `reservation upsert will retry after property sync completes`
      )
    }

    // Scoped to the resolved org — an unscoped lookup could hit a
    // co-hosted twin reservation belonging to a different customer and
    // read the wrong existing dates, feeding a false datesChanged result.
    // Unwrapped. The comment above reasons about reading the WRONG dates; a
    // failed read is the other way this goes wrong and was unhandled — null
    // makes `datesChanged` below true, so every webhook during a read outage
    // regenerates this property's turnovers. That errs in the safe direction
    // (better to regenerate than to miss a real date change) but it does so
    // silently and with churn, and turnover/created events fan out from it.
    const existingRes = await supabase
      .from('bookings')
      .select('checkin_date, checkout_date')
      .eq('org_id',          orgId)
      .eq('external_id',     entityId)
      .eq('external_source', PROVIDER)
      .maybeSingle()

    const existing = unwrap(existingRes, {
      site: 'inngest.hospitable-incremental.existing-booking', orgId,
    })

    const normalized = hospitableReservationToNormalized(reservation)

    // bookings.checkin_date/checkout_date are NOT NULL, but Hospitable's
    // normalized shape allows null (their payload does not always carry both).
    // A row missing either would be rejected by Postgres (23502), so there is
    // no booking to record — say so instead of throwing a raw constraint error.
    if (normalized.checkin_date === null || normalized.checkout_date === null) {
      throw new NonRetriableError(
        `Hospitable reservation ${normalized.external_id} has no ${
          normalized.checkin_date === null ? 'arrival' : 'departure'
        } date — cannot store a booking without it`
      )
    }

    const datesChanged = !existing
      || existing.checkin_date  !== normalized.checkin_date
      || existing.checkout_date !== normalized.checkout_date

    const { data: upserted, error } = await supabase
      .from('bookings')
      .upsert(
        {
          org_id:               orgId,
          property_id:          property.id,
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
        },
        { onConflict: 'org_id,external_id,external_source' }
      )
      .select('id')
      .single()

    if (error) throw new Error(`Booking upsert failed: ${error.message}`)

    return {
      datesChanged,
      status:      normalized.status,
      propertyId:  property.id,
      bookingId:   upserted.id as string,
      actualTotalAmount: normalized.actual_total_amount,
      // Only a confirmed, paying-guest stay should post revenue — not
      // a tentative request, a cancellation, or the owner's own stay.
      shouldPostRevenue: normalized.status === 'confirmed' && normalized.stay_type === 'guest_stay',
    }
  })

  // Post revenue for confirmed guest stays — the first producer
  // booking/confirmed has ever had; see
  // lib/inngest/functions/booking-events.ts. Fires on every qualifying
  // upsert (not just new ones) — handleBookingConfirmed's own upsert
  // onConflict (source_reference_id, source) DO NOTHING already makes
  // a repeat post for the same booking a no-op.
  if (upsertResult.shouldPostRevenue) {
    await step.sendEvent('post-booking-revenue', {
      name: 'booking/confirmed' as const,
      data: {
        booking_id:          upsertResult.bookingId,
        property_id:         upsertResult.propertyId,
        org_id:              orgId,
        source:              'hospitable' as const,
        actual_total_amount: upsertResult.actualTotalAmount,
      },
    })
  }

  // A reservation can flip to 'cancelled' (status_changed trigger)
  // without its dates changing at all — datesChanged alone would never
  // catch this, and the 404 branch above only fires when Hospitable
  // deletes the reservation outright, not when it survives with a
  // cancelled status. Check status explicitly and short-circuit before
  // the datesChanged regeneration path below.
  if (upsertResult.status === 'cancelled') {
    const cancelledAssignments = await step.run('cancel-turnovers-for-status-change', async () => {
      const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
      return cancelTurnoversForBooking(upsertResult.bookingId, supabase)
    })

    await step.run('notify-crew-status-change', async () => {
      await notifyCrewOfCancelledTurnovers(cancelledAssignments)
    })

    return { action: 'cancelled-via-status', entity_id: entityId }
  }

  // Regenerate turnovers only when dates changed.
  // generateTurnoversForProperty returns string[] (new turnover IDs) —
  // we then fetch the full rows to build turnover/created events.
  if (upsertResult.datesChanged) {
    const newTurnoverIds = await step.run('regenerate-turnovers', async () => {
      const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
      return generateTurnoversForProperty(upsertResult.propertyId, orgId, supabase)
    })

    if (newTurnoverIds.length > 0) {
      const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
        const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
        return fetchTurnoverCreatedEvents(supabase, newTurnoverIds, orgId)
      })

      if (turnoverEvents.length > 0) {
        await step.sendEvent('fire-turnover-events', turnoverEvents)
      }
    }
  }

  return { action: 'upserted', entity_id: entityId, datesChanged: upsertResult.datesChanged }
}

/**
 * Property: refresh the property from Hospitable (a 404 deactivates it),
 * then run the post-upsert seeding — guidebook config, amenity-derived
 * assets, and the new-property setup nudge. Every seeding step is
 * best-effort: it logs and reports, but never fails the sync.
 */
async function syncProperty(
  { step, logger, entityId, externalUserId }: EntityContext
) {

  // See the reservation branch — ownership must come from
  // resolveHospitableOwner(), never from an arbitrary active connection.
  const resolved = await withProviderCall(step, 'resolve-org-and-token', async () => {
    const owner = await resolveHospitableOwner({
      entityKind:     'property',
      externalId:     entityId,
      externalUserId,
    })

    if (!owner) return { skipped: true as const }

    // isNewProperty drives the post-upsert seeding steps below (master
    // checklist, guidebook config, amenity-derived assets). Recomputed
    // here against the RESOLVED org rather than an unscoped lookup, so a
    // co-hosted property already synced by a different customer is still
    // correctly treated as new for this org.
    const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
    // Unwrapped: null makes isNewProperty true, which re-runs the whole
    // first-time seeding path (master checklist, guidebook config, amenity
    // assets) for a property that already has it. applyMasterChecklist's
    // force:false guard absorbs the checklist half; the rest is wasted work
    // plus a spurious "new property" PM notification.
    const existingPropertyRes = await supabase
      .from('properties')
      .select('id')
      .eq('org_id',          owner.orgId)
      .eq('external_id',     entityId)
      .eq('external_source', PROVIDER)
      .maybeSingle()

    const existingProperty = unwrap(existingPropertyRes, {
      site: 'inngest.hospitable-incremental.existing-property', orgId: owner.orgId,
    })

    return {
      skipped:       false as const,
      orgId:         owner.orgId,
      token:         owner.token,
      isNewProperty: !existingProperty,
    }
  })

  if (resolved.skipped) {
    logger.info(`[Hospitable incremental] Skipping property ${entityId} — no active Hospitable connection`)
    return { skipped: true, reason: 'no_active_connection', entity_id: entityId }
  }

  const { orgId, token, isNewProperty } = resolved

  const fetchAndUpsertResult = await withProviderCall(step, 'fetch-and-upsert-property', async () => {
    // bookings is speculative — see HospitableProperty.bookings.
    const res = await hospitableFetch(
      `${HOSPITABLE_API_BASE}/properties/${entityId}?include=details,bookings`,
      token
    )

    if (res.status === 404) {
      const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
      const { error } = await supabase
        .from('properties')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('external_id',     entityId)
        .eq('external_source', PROVIDER)
        .eq('org_id',          orgId)

      if (error) throw new Error(`mark-inactive failed: ${error.message}`)
      logger.info(`[Hospitable incremental] Property ${entityId} marked inactive`)
      return { action: 'deactivated', propertyId: undefined as string | undefined, propertyName: undefined as string | undefined }
    }

    if (!res.ok) {
      throw new Error(
        `Hospitable GET /properties/${entityId} failed: HTTP ${res.status}`
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
        reportError(err, { site: 'inngest.hospitable-incremental-sync.sync-guidebook-config-for-property' })
        // Non-fatal — don't throw, don't block the sync
      }
    })

    await step.run('seed-asset-discovery-for-property', async () => {
      try {
        const { seeded } = await seedPresentAssetsFromAmenities(orgId, [propertyId])
        logger.info(`[Hospitable incremental] Asset discovery seeded for property ${propertyId}: ${seeded ? 'yes' : 'no new assets'}`)
      } catch (err) {
        logger.error(`[Hospitable incremental] asset discovery seed failed for property ${propertyId}: ${err instanceof Error ? err.message : String(err)}`)
        reportError(err, { site: 'inngest.hospitable-incremental-sync.seed-asset-discovery-for-property' })
        // Non-fatal — don't throw, don't block the sync
      }
    })

    await step.run('seed-absent-optional-assets-for-property', async () => {
      try {
        await seedAbsentOptionalAssetsFromAmenities(orgId, [propertyId])
      } catch (err) {
        logger.warn(`[Hospitable incremental] absent-optional-asset seeding failed for property ${propertyId}: ${err instanceof Error ? err.message : String(err)}`)
        reportError(err, { site: 'inngest.hospitable-incremental-sync.seed-absent-optional-assets-for-property' })
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
          const supabase = createServiceClient({ system: 'inngest:incremental-sync' })
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
          reportError(err, { site: 'inngest.hospitable-incremental-sync.notify-new-property-setup' })
          // Non-fatal — don't throw, don't block the sync
        }
      })
    }
  }

  return { action: 'synced', entity_id: entityId }
}

/**
 * Review: upsert it against the live reviews schema and kick off RepuGuard
 * batch generation for the org.
 */
async function syncReview(
  { step, logger, entityId, externalUserId }: EntityContext
) {

  // See the reservation branch — ownership must come from
  // resolveHospitableOwner(), never from an arbitrary active connection.
  // The downstream property_id resolution already scopes to this orgId,
  // so a correct org here is load-bearing for review attribution too.
  const resolved = await resolveOwnerOrSkip(step, logger, 'review', entityId, externalUserId)
  if (!resolved) return noActiveConnection(entityId)

  const { orgId, token } = resolved

  // Fetch review and upsert using live reviews table schema:
  //   guest_name, review_text, rating (NOT NULL), review_date, property_id (UUID FK)
  const upsertResult = await withProviderCall(step, 'fetch-and-upsert-review', async () => {
    const res = await hospitableFetch(
      `${HOSPITABLE_API_BASE}/reviews/${entityId}`,
      token
    )

    if (!res.ok) {
      if (res.status === 404) {
        throw new NonRetriableError(
          `Review ${entityId} returned 404 from Hospitable — skipping`
        )
      }
      throw new Error(
        `Hospitable GET /reviews/${entityId} failed: HTTP ${res.status}`
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

    const supabase          = createServiceClient({ system: 'inngest:incremental-sync' })
    let   resolvedPropertyId: string | null = null

    // Resolve property_id (FK) from the Hospitable property UUID, scoped
    // to the org already resolved from this webhook's integration_connection
    // (see resolve-org-and-token above) — a property row from a different
    // org sharing the same external_id must never override that trusted org.
    const hospPropertyId = review.property?.id ?? null
    if (hospPropertyId) {
      // Unwrapped: a failed read left resolvedPropertyId null and the review
      // was stored unattached to any property — permanently, since nothing
      // re-links it later.
      const propRes = await supabase
        .from('properties')
        .select('id')
        .eq('org_id',          orgId)
        .eq('external_id',     hospPropertyId)
        .eq('external_source', PROVIDER)
        .maybeSingle()

      const prop = unwrap(propRes, {
        site: 'inngest.hospitable-incremental.review-property', orgId,
      })

      if (prop) {
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
          org_id:          orgId,
          external_id:     entityId,
          external_source: PROVIDER,
          property_id:     resolvedPropertyId,
          guest_name:      guestName,
          rating:          review.public?.rating ?? 0,
          review_text:     review.public?.review ?? '',
          review_date:     review.reviewed_at ?? null,
          response_status: 'pending',
        },
        { onConflict: 'org_id,external_id,external_source' }
      )
      .select('id')
      .single()

    if (error) throw new Error(`Review upsert failed: ${error.message}`)

    return { upserted: true, reviewId: upserted?.id, orgId }
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

  return { action: 'synced', entity_id: entityId }
}

