// lib/inngest/functions/hospitable/reservation-sync.ts
// ============================================================
// The Hospitable reservation pipeline: fetch windows → upsert bookings →
// post revenue → regenerate turnovers.
//
// WHY THIS IS SHARED RATHER THAN COPIED
//
// Two callers need the identical sequence:
//   - hospInitialSync              — once, when a PM connects
//   - hospReservationReconcileHandler — daily, as the missed-webhook backstop
//
// Copying it would put the org_id scoping, the two silent-drop guards
// (unmapped property, NULL stay dates), the revenue-eligibility predicate and
// the turnover regeneration in two places that must stay in step forever.
// This repo has been bitten by exactly that shape more than once, so the
// pipeline lives here and both callers pass parameters instead.
//
// Step ids are unchanged from the ones hospInitialSync used inline, so an
// in-flight run mid-deploy resumes on the same ids rather than replaying.
//
// STEP TOOLING: this module lives under lib/inngest/, which is where
// unit/guardrails/inngest-nested-steps.test.ts permits a helper to receive
// `step`. Every step.run/sendEvent below is at this function's top level —
// none is nested inside another step's callback.
// ============================================================

import type { GetStepTools }  from 'inngest'
import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }       from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { reportError }        from '@/lib/observability/report-error'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import {
  hospReservationWindows,
  fetchReservationsWindow,
  hospitableReservationToNormalized,
  type HospitableReservation,
} from '@/lib/integrations/providers/hospitable'

const PROVIDER = 'hospitable'

type SyncStep = GetStepTools<typeof inngest>

/**
 * Narrow structural type for Inngest's logger. Deliberately not `any` (banned)
 * and not Inngest's own Logger type, which would couple this module to the
 * SDK's surface for three methods.
 */
interface SyncLogger {
  info:  (msg: string) => void
  warn:  (msg: string) => void
  error: (msg: string) => void
}

/**
 * Which reservations get a `booking/confirmed` event.
 *
 *  'all'      — every revenue-eligible reservation in the window. Correct for
 *               initial sync and for a manual resync: handleBookingConfirmed
 *               dedups on (source_reference_id, source) DO NOTHING, so a
 *               repeat is a no-op, and firing broadly REPAIRS an org whose
 *               revenue post previously failed.
 *
 *  'new-only' — only reservations that did not already exist as a booking
 *               before this upsert. Correct for the daily reconcile: 'all'
 *               there would fire one event per confirmed booking per org per
 *               day forever — thousands of guaranteed no-ops — to catch the
 *               handful that webhooks actually missed.
 */
export type RevenueMode = 'all' | 'new-only'

export interface ReservationSyncParams {
  step:   SyncStep
  logger: SyncLogger
  /** Hospitable API token for this connection. */
  token:  string
  orgId:  string
  /** Only used to label log lines, matching the existing `[Hospitable:<id>]` prefix. */
  userId: string
  /** Hospitable property external_id → FieldStay properties.id. */
  propertyIdMap:   Record<string, string>
  /** How far forward to sweep. */
  lookaheadMonths: number
  /** Names the RLS bypass for createServiceClient — see ServiceRoleContext. */
  system:      string
  revenueMode: RevenueMode
}

export interface ReservationSyncResult {
  reservationCount: number
  newTurnoverIds:   string[]
}

/**
 * Fetches every reservation in the window, upserts them as bookings, posts
 * revenue for the eligible ones, and regenerates turnovers for the affected
 * properties.
 *
 * Call at most ONCE per Inngest run — the step ids below are fixed, so a
 * second call in the same run would collide.
 */
export async function syncHospitableReservations(
  params: ReservationSyncParams,
): Promise<ReservationSyncResult> {
  const {
    step, logger, token, orgId, userId,
    propertyIdMap, lookaheadMonths, system, revenueMode,
  } = params

  // ── 1. Fetch reservations, one Inngest step per start_date window ─────────
  //     Each window retries independently: a rate-limit throw on window 20
  //     no longer discards windows 1-19 and restarts the whole fetch.
  const hospPropertyIds = Object.keys(propertyIdMap)

  const windows = hospPropertyIds.length
    ? hospReservationWindows(undefined, lookaheadMonths)
    : []

  const reservationsById = new Map<string, HospitableReservation>()

  for (const startDate of windows) {
    const windowReservations = await step.run(
      `fetch-reservations-window-${startDate}`,
      () => fetchReservationsWindow(token, startDate, hospPropertyIds),
    )
    for (const r of windowReservations) reservationsById.set(r.id, r)
  }

  const reservations = Array.from(reservationsById.values())
  logger.info(`[Hospitable:${userId}] Fetched ${reservations.length} reservations across ${windows.length} windows`)

  // ── 2. Upsert as bookings ────────────────────────────────────────────────
  const { reservationCount, revenueEligibleExternalIds } = await step.run('upsert-reservations', async () => {
    if (!hospPropertyIds.length) return { reservationCount: 0, revenueEligibleExternalIds: [] as string[] }

    const supabase = createServiceClient({ system })
    let count = 0
    const revenueEligible: string[] = []

    const bookingRows = reservations
      .map((res) => {
        const normalized = hospitableReservationToNormalized(res)
        const propertyId = normalized.property_external_id
          ? propertyIdMap[normalized.property_external_id]
          : null

        if (!propertyId) {
          logger.warn(
            `[Hospitable:${userId}] Skipping reservation ${res.id} — ` +
            `no FieldStay property found for Hospitable property ` +
            `${normalized.property_external_id ?? 'unknown'}`
          )
          return null
        }

        // bookings.checkin_date/checkout_date are NOT NULL. Because this
        // is a BULK upsert, one reservation missing either date would make
        // Postgres reject the whole batch (23502) and lose every other
        // booking in it — so skip it the same way an unmapped property is
        // skipped, loudly.
        if (normalized.checkin_date === null || normalized.checkout_date === null) {
          logger.warn(
            `[Hospitable:${userId}] Skipping reservation ${res.id} — missing ` +
            `${normalized.checkin_date === null ? 'arrival' : 'departure'} date`
          )
          return null
        }

        // Only a confirmed, paying-guest stay should post revenue — not
        // a tentative request, a cancellation, or the owner's own stay.
        if (normalized.status === 'confirmed' && normalized.stay_type === 'guest_stay') {
          revenueEligible.push(normalized.external_id)
        }

        return {
          org_id:               orgId,
          property_id:          propertyId,
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
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)

    // Which of the eligible reservations are genuinely NEW must be answered
    // BEFORE the upsert — afterwards every one of them exists. Reads inside
    // this step rather than as its own step so the initial-sync path's step
    // sequence is byte-identical to what it was when this was inline.
    let postable = revenueEligible
    if (revenueMode === 'new-only' && revenueEligible.length) {
      // `external_id` is nullable on bookings (iCal rows have none), so the
      // row type must admit null even though this filtered read can't return
      // one — the Set below drops them regardless.
      const existing = await fetchAllRows<{ external_id: string | null }>(
        (from, to) => supabase
          .from('bookings')
          .select('external_id')
          .eq('org_id', orgId)
          .eq('external_source', PROVIDER)
          .in('external_id', revenueEligible)
          .order('external_id', { ascending: true })
          .range(from, to),
        { label: `existing-bookings(hospitable)[org=${orgId}]` },
      )
      const seen = new Set(existing.map((r) => r.external_id))
      postable = revenueEligible.filter((id) => !seen.has(id))
    }

    if (bookingRows.length) {
      const { error } = await supabase
        .from('bookings')
        .upsert(bookingRows, { onConflict: 'org_id,external_id,external_source' })

      if (error) {
        logger.error(`[Hospitable:${userId}] bookings upsert failed: ${error.message}`)
        throw new Error(`Bookings upsert failed: ${error.message}`)
      }
      count = bookingRows.length
    }

    return { reservationCount: count, revenueEligibleExternalIds: postable }
  })

  // ── 3. Post revenue for confirmed guest stays ────────────────────────────
  // The first producer booking/confirmed has ever had — see
  // lib/inngest/functions/booking-events.ts. handleBookingConfirmed's
  // own upsert (onConflict source_reference_id,source DO NOTHING)
  // makes a repeat post for the same booking a no-op, so re-running
  // this pipeline can't double-post.
  if (revenueEligibleExternalIds.length > 0) {
    const revenueEvents = await step.run('fetch-bookings-for-revenue', async () => {
      const supabase = createServiceClient({ system })
      // Paginated AND error-bound, for two separate reasons.
      //
      // Paginated: this is one row per reservation just imported, so it is
      // sized by the org's whole booking history, not by its property count.
      // A PM onboarding 50 properties with a year of stays each is past
      // PostgREST's max_rows = 1000 on day one, and truncation there is
      // silent — the rows past 1000 simply never produce a booking/confirmed
      // event.
      //
      // Error-bound: `?? []` on a failed read meant ZERO booking/confirmed
      // events, so no revenue is posted to owner_transactions for any of
      // this org's imported reservations — a silent financial omission that
      // the sync then reports as a clean run. fetchAllRows throws on a page
      // error, so the step gets an Inngest retry instead.
      const rows = await fetchAllRows<{ id: string; property_id: string; actual_total_amount: number | null }>(
        (from, to) => supabase
          .from('bookings')
          .select('id, property_id, actual_total_amount')
          .eq('org_id', orgId)
          .eq('external_source', PROVIDER)
          .in('external_id', revenueEligibleExternalIds)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `bookings-for-revenue(hospitable)[org=${orgId}]` },
      )

      return rows.map((b) => ({
        name: 'booking/confirmed' as const,
        data: {
          booking_id:          b.id as string,
          property_id:         b.property_id as string,
          org_id:              orgId,
          source:              'hospitable' as const,
          actual_total_amount: b.actual_total_amount as number | null,
        },
      }))
    })

    if (revenueEvents.length > 0) {
      await step.sendEvent('fire-booking-confirmed-events', revenueEvents)
    }
  }

  // ── 4. Generate turnovers for each property that received bookings ───────
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
        logger.error(`[Hospitable:${userId}] Turnover generation failed for ${propertyId}: ${err}`)
        reportError(err, { site: 'inngest.hospitable-reservation-sync.generate-turnovers' })
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
