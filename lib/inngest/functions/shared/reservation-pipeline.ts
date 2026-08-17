// lib/inngest/functions/shared/reservation-pipeline.ts
// ============================================================================
// The provider-agnostic half of every PMS reservation sync: normalized
// bookings in, upserted rows + posted revenue + regenerated turnovers out.
//
// WHY THIS EXISTS
//
// Hostex's pipeline landed as a near-copy of Hospitable's — SonarCloud put
// hostex/reservation-sync.ts at 45.8% duplicated on the introducing PR. The
// copied part was not boilerplate: it was the two silent-drop guards, the
// revenue-eligibility predicate, the max_rows-safe revenue read and the
// turnover regeneration. Those are precisely the pieces this repo has been
// bitten by before, and a second copy is a second place for each to be fixed
// in isolation and drift.
//
// THE SEAM is FETCH vs. EVERYTHING AFTER. Fetching is irreducibly
// provider-specific — Hospitable fans out one Inngest step per date window
// against a shared 54 req/min budget; Hostex issues one ranged request, or
// reads a single reservation by code when a webhook names one. Everything
// downstream operates on NormalizedBooking and is identical, so that is what
// moved here.
//
// STEP IDS ARE PART OF THE CONTRACT. Inngest memoizes on them, so they are
// spelled exactly as both providers already used them — a run in flight across
// the deploy that introduced this resumes rather than replaying. Do not rename
// one to read better.
//
// STEP TOOLING: lives under lib/inngest/, where
// unit/guardrails/inngest-nested-steps.test.ts permits a helper to receive
// `step`. Every step.run/sendEvent below is at the calling function's top
// level — none is nested inside another step's callback.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }       from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { reportError }        from '@/lib/observability/report-error'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import type { NormalizedBooking } from '@/lib/bookings/normalize'

type SyncStep = GetStepTools<typeof inngest>

/**
 * Narrow structural type for Inngest's logger. Deliberately not `any` (banned)
 * and not Inngest's own Logger type, which would couple this module to the
 * SDK's surface for three methods.
 */
export interface SyncLogger {
  info:  (msg: string) => void
  warn:  (msg: string) => void
  error: (msg: string) => void
}

/**
 * Which reservations get a `booking/confirmed` event.
 *
 *  'all'      — every revenue-eligible reservation. Correct for an initial
 *               sync and a manual resync: handleBookingConfirmed dedups on
 *               (source_reference_id, source) DO NOTHING, so a repeat is a
 *               no-op, and firing broadly REPAIRS an org whose revenue post
 *               previously failed.
 *
 *  'new-only' — only reservations that did not already exist as a booking
 *               before this upsert. Correct for a recurring reconcile: 'all'
 *               there would fire one event per confirmed booking per org per
 *               day forever — thousands of guaranteed no-ops.
 */
export type RevenueMode = 'all' | 'new-only'

/** The providers whose reservations flow through here. */
export type ReservationProvider = 'hospitable' | 'hostex' | 'hostaway'

/**
 * Log-line prefix per provider. A lookup rather than a ternary chain: with
 * three providers the chain's fallback silently mislabels any new member as
 * the last branch, which is how a Hostaway sync would have logged itself as
 * `[Hospitable:<id>]` and sent someone reading the logs to the wrong file.
 */
const PROVIDER_LABELS: Record<ReservationProvider, string> = {
  hospitable: 'Hospitable',
  hostex:     'Hostex',
  hostaway:   'Hostaway',
}

export interface ReservationPipelineParams {
  step:     SyncStep
  logger:   SyncLogger
  provider: ReservationProvider
  orgId:    string
  /** Only labels log lines, matching the existing `[Provider:<id>]` prefix. */
  userId:   string
  /** Provider property external_id → FieldStay properties.id. */
  propertyIdMap: Record<string, string>
  /** Already fetched and mapped by the caller — the provider-specific half. */
  reservations:  NormalizedBooking[]
  /** Names the RLS bypass for createServiceClient — see ServiceRoleContext. */
  system:      string
  revenueMode: RevenueMode
}

export interface ReservationPipelineResult {
  reservationCount: number
  newTurnoverIds:   string[]
}

/**
 * Upsert normalized reservations as bookings, post revenue for the eligible
 * ones, and regenerate turnovers for the affected properties.
 *
 * Call at most ONCE per Inngest run — the step ids are fixed, so a second call
 * in the same run would collide.
 */
export async function runReservationPipeline(
  params: ReservationPipelineParams,
): Promise<ReservationPipelineResult> {
  const { step, logger, provider, orgId, userId, propertyIdMap, reservations, system, revenueMode } = params

  const label            = `[${PROVIDER_LABELS[provider]}:${userId}]`
  const providerPropIds  = Object.keys(propertyIdMap)

  // ── 1. Upsert as bookings ────────────────────────────────────────────────
  const { reservationCount, revenueEligibleExternalIds } = await step.run('upsert-reservations', async () => {
    if (!providerPropIds.length) return { reservationCount: 0, revenueEligibleExternalIds: [] as string[] }

    const supabase = createServiceClient({ system })
    const revenueEligible: string[] = []

    const bookingRows = reservations
      .map((normalized) => {
        const propertyId = normalized.property_external_id
          ? propertyIdMap[normalized.property_external_id]
          : null

        // A reservation on a property we never imported. Loud, because
        // silently dropping stays is how a calendar ends up plausibly wrong
        // rather than obviously broken.
        if (!propertyId) {
          logger.warn(
            `${label} Skipping reservation ${normalized.external_id} — ` +
            `no FieldStay property found for ${provider} property ` +
            `${normalized.property_external_id ?? 'unknown'}`
          )
          return null
        }

        // bookings.checkin_date/checkout_date are NOT NULL. Because this is a
        // BULK upsert, one reservation missing either date would make Postgres
        // reject the whole batch (23502) and lose every other booking in it —
        // so skip it the same way an unmapped property is skipped, loudly.
        if (normalized.checkin_date === null || normalized.checkout_date === null) {
          logger.warn(
            `${label} Skipping reservation ${normalized.external_id} — missing ` +
            `${normalized.checkin_date === null ? 'arrival' : 'departure'} date`
          )
          return null
        }

        // Only a confirmed, paying-guest stay posts revenue — not a tentative
        // request, a cancellation, or the owner's own stay.
        if (normalized.status === 'confirmed' && normalized.stay_type === 'guest_stay') {
          revenueEligible.push(normalized.external_id)
        }

        return {
          org_id:              orgId,
          property_id:         propertyId,
          external_source:     provider,
          external_id:         normalized.external_id,
          checkin_date:        normalized.checkin_date,
          checkout_date:       normalized.checkout_date,
          checkin_time:        normalized.checkin_time,
          checkout_time:       normalized.checkout_time,
          status:              normalized.status,
          guest_name:          normalized.guest_name,
          guest_email:         normalized.guest_email,
          source:              normalized.source,
          is_block:            normalized.is_block,
          stay_type:           normalized.stay_type,
          actual_total_amount: normalized.actual_total_amount,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)

    // Which of the eligible reservations are genuinely NEW must be answered
    // BEFORE the upsert — afterwards every one of them exists.
    let postable = revenueEligible
    if (revenueMode === 'new-only' && revenueEligible.length) {
      // `external_id` is nullable on bookings (iCal rows have none), so the
      // row type must admit null even though this filtered read cannot return
      // one — the Set below drops them regardless.
      const existing = await fetchAllRows<{ external_id: string | null }>(
        (from, to) => supabase
          .from('bookings')
          .select('external_id')
          .eq('org_id', orgId)
          .eq('external_source', provider)
          .in('external_id', revenueEligible)
          .order('external_id', { ascending: true })
          .range(from, to),
        { label: `existing-bookings(${provider})[org=${orgId}]` },
      )
      const seen = new Set(existing.map((r) => r.external_id))
      postable = revenueEligible.filter((id) => !seen.has(id))
    }

    if (bookingRows.length) {
      const { error } = await supabase
        .from('bookings')
        .upsert(bookingRows, { onConflict: 'org_id,external_id,external_source' })

      if (error) {
        logger.error(`${label} bookings upsert failed: ${error.message}`)
        throw new Error(`Bookings upsert failed: ${error.message}`)
      }
    }

    return { reservationCount: bookingRows.length, revenueEligibleExternalIds: postable }
  })

  // ── 2. Post revenue for confirmed guest stays ────────────────────────────
  // The only producer booking/confirmed has — see
  // lib/inngest/functions/booking-events.ts. That handler's own upsert
  // (onConflict source_reference_id,source DO NOTHING) makes a repeat post for
  // the same booking a no-op, so re-running this pipeline cannot double-post.
  if (revenueEligibleExternalIds.length > 0) {
    const revenueEvents = await step.run('fetch-bookings-for-revenue', async () => {
      const supabase = createServiceClient({ system })

      // Paginated AND error-bound, for two separate reasons.
      //
      // Paginated: one row per reservation just imported, so it is sized by
      // the org's whole booking history, not its property count. A PM
      // onboarding 50 properties with a year of stays each is past
      // PostgREST's max_rows = 1000 on day one, and truncation there is
      // silent — the rows past 1000 simply never produce a booking/confirmed
      // event.
      //
      // Error-bound: `?? []` on a failed read meant ZERO events, so no revenue
      // is posted to owner_transactions for any of this org's imported
      // reservations — a silent financial omission that the sync then reports
      // as a clean run. fetchAllRows throws on a page error, so the step gets
      // an Inngest retry instead.
      const rows = await fetchAllRows<{ id: string; property_id: string; actual_total_amount: number | null }>(
        (from, to) => supabase
          .from('bookings')
          .select('id, property_id, actual_total_amount')
          .eq('org_id', orgId)
          .eq('external_source', provider)
          .in('external_id', revenueEligibleExternalIds)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `bookings-for-revenue(${provider})[org=${orgId}]` },
      )

      return rows.map((b) => ({
        name: 'booking/confirmed' as const,
        data: {
          booking_id:          b.id,
          property_id:         b.property_id,
          org_id:              orgId,
          source:              provider,
          actual_total_amount: b.actual_total_amount,
        },
      }))
    })

    if (revenueEvents.length > 0) {
      await step.sendEvent('fire-booking-confirmed-events', revenueEvents)
    }
  }

  // ── 3. Generate turnovers for each property that received bookings ───────
  const affectedPropertyIds = [...new Set(Object.values(propertyIdMap))]

  const newTurnoverIds = await step.run('generate-turnovers', async () => {
    if (!affectedPropertyIds.length) return []
    const supabase = createServiceClient({ system })
    const ids: string[] = []
    for (const propertyId of affectedPropertyIds) {
      try {
        const newIds = await generateTurnoversForProperty(propertyId, orgId, supabase)
        ids.push(...newIds)
      } catch (err) {
        logger.error(`${label} Turnover generation failed for ${propertyId}: ${err}`)
        reportError(err, { site: `inngest.${provider}-reservation-sync.generate-turnovers` })
      }
    }
    return ids
  })

  if (newTurnoverIds.length > 0) {
    const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
      const supabase = createServiceClient({ system })
      return fetchTurnoverCreatedEvents(supabase, newTurnoverIds, orgId)
    })

    if (turnoverEvents.length > 0) {
      await step.sendEvent('fire-turnover-events', turnoverEvents)
    }
  }

  return { reservationCount, newTurnoverIds }
}

/**
 * Provider property external_id → FieldStay properties.id, read from our own
 * rows. Identical in both providers' reconcile handlers.
 *
 * Paginated on principle: a truncated map here does not merely shorten a list,
 * it silently drops every reservation on the missing properties via the
 * unmapped-property guard above.
 */
export async function fetchProviderPropertyIdMap(
  orgId:    string,
  provider: ReservationProvider,
  system:   string,
): Promise<Record<string, string>> {
  const supabase = createServiceClient({ system })

  const rows = await fetchAllRows<{ id: string; external_id: string | null }>(
    (from, to) => supabase
      .from('properties')
      .select('id, external_id')
      .eq('org_id', orgId)
      .eq('external_source', provider)
      .eq('is_active', true)
      .not('external_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
    { label: `${provider}-reconcile.properties[org=${orgId}]` },
  )

  const map: Record<string, string> = {}
  for (const r of rows) if (r.external_id) map[r.external_id] = r.id
  return map
}
