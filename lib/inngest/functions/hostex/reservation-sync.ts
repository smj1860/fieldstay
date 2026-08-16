// lib/inngest/functions/hostex/reservation-sync.ts
// ============================================================================
// The Hostex reservation pipeline: fetch → upsert bookings → post revenue →
// regenerate turnovers.
//
// Shared rather than copied, for the same reason hospitable/reservation-sync.ts
// is: two callers need the identical sequence (hostexInitialSync on connect,
// hostexReservationReconcileHandler on the daily cron), and copying it would
// put the org scoping, the two silent-drop guards, the revenue-eligibility
// predicate and the turnover regeneration in two places that must stay in step
// forever.
//
// STEP TOOLING: this module lives under lib/inngest/, where
// unit/guardrails/inngest-nested-steps.test.ts permits a helper to receive
// `step`. Every step.run/sendEvent below is at the caller function's top
// level — none is nested inside another step's callback.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }       from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { reportError }        from '@/lib/observability/report-error'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { hostexFetchReservations, hostexReservationWindow } from '@/lib/integrations/providers/hostex-api'
import { hostexReservationToNormalized } from '@/lib/integrations/providers/hostex.mappers'

const PROVIDER = 'hostex'

type SyncStep = GetStepTools<typeof inngest>

interface SyncLogger {
  info:  (msg: string) => void
  warn:  (msg: string) => void
  error: (msg: string) => void
}

/**
 * Which reservations get a `booking/confirmed` event. Same contract as the
 * Hospitable pipeline's RevenueMode:
 *
 *  'all'      — every revenue-eligible reservation. Correct for initial sync
 *               and manual resync; handleBookingConfirmed dedups on
 *               (source_reference_id, source) DO NOTHING, so a repeat is a
 *               no-op and firing broadly REPAIRS an org whose revenue post
 *               previously failed.
 *  'new-only' — only reservations that were not already bookings. Correct for
 *               the daily reconcile, where 'all' would fire thousands of
 *               guaranteed no-ops per org per day.
 */
export type RevenueMode = 'all' | 'new-only'

export interface HostexReservationSyncParams {
  step:   SyncStep
  logger: SyncLogger
  token:  string
  orgId:  string
  userId: string
  /** Hostex property id (as a string) → FieldStay properties.id. */
  propertyIdMap:   Record<string, string>
  historyMonths:   number
  lookaheadMonths: number
  system:      string
  revenueMode: RevenueMode
}

export interface HostexReservationSyncResult {
  reservationCount: number
  newTurnoverIds:   string[]
}

export async function syncHostexReservations(
  params: HostexReservationSyncParams,
): Promise<HostexReservationSyncResult> {
  const {
    step, logger, token, orgId, userId,
    propertyIdMap, historyMonths, lookaheadMonths, system, revenueMode,
  } = params

  const hostexPropertyIds = Object.keys(propertyIdMap)

  // ── 1. Fetch reservations ────────────────────────────────────────────────
  // One step, one date range. Hospitable fans out per-window because its 54
  // req/min budget is shared platform-wide and a late failure there would
  // re-fetch everything; Hostex's budget is per-token at 600 req/min, so the
  // pressure that justified that complexity does not exist here.
  const reservations = await step.run('fetch-reservations', async () => {
    if (!hostexPropertyIds.length) return []
    const window = hostexReservationWindow(historyMonths, lookaheadMonths)
    const rows   = await hostexFetchReservations(token, userId, window)
    return rows
  })

  logger.info(`[Hostex:${userId}] Fetched ${reservations.length} reservations`)

  // ── 2. Upsert as bookings ────────────────────────────────────────────────
  const { reservationCount, revenueEligibleExternalIds } = await step.run('upsert-reservations', async () => {
    if (!hostexPropertyIds.length) return { reservationCount: 0, revenueEligibleExternalIds: [] as string[] }

    const supabase = createServiceClient({ system })
    const revenueEligible: string[] = []

    const bookingRows = reservations
      .map((res) => {
        const normalized = hostexReservationToNormalized(res)
        const propertyId = normalized.property_external_id
          ? propertyIdMap[normalized.property_external_id]
          : null

        // A reservation for a property we have not imported. Loud, because
        // silently dropping stays is how a PM's calendar ends up plausibly
        // wrong rather than obviously broken.
        if (!propertyId) {
          logger.warn(
            `[Hostex:${userId}] Skipping reservation ${res.reservation_code} — ` +
            `no FieldStay property for Hostex property ${normalized.property_external_id ?? 'unknown'}`
          )
          return null
        }

        // bookings.checkin_date/checkout_date are NOT NULL, and this is a BULK
        // upsert — one row missing either date makes Postgres reject the whole
        // batch (23502) and lose every other booking with it.
        if (!normalized.checkin_date || !normalized.checkout_date) {
          logger.warn(
            `[Hostex:${userId}] Skipping reservation ${res.reservation_code} — missing ` +
            `${normalized.checkin_date ? 'check_out_date' : 'check_in_date'}`
          )
          return null
        }

        if (normalized.status === 'confirmed') {
          revenueEligible.push(normalized.external_id)
        }

        return {
          org_id:              orgId,
          property_id:         propertyId,
          external_source:     PROVIDER,
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

    // Which eligible reservations are genuinely NEW has to be answered BEFORE
    // the upsert — afterwards every one of them exists.
    let postable = revenueEligible
    if (revenueMode === 'new-only' && revenueEligible.length) {
      const existing = await fetchAllRows<{ external_id: string | null }>(
        (from, to) => supabase
          .from('bookings')
          .select('external_id')
          .eq('org_id', orgId)
          .eq('external_source', PROVIDER)
          .in('external_id', revenueEligible)
          .order('external_id', { ascending: true })
          .range(from, to),
        { label: `existing-bookings(hostex)[org=${orgId}]` },
      )
      const seen = new Set(existing.map((r) => r.external_id))
      postable = revenueEligible.filter((id) => !seen.has(id))
    }

    if (bookingRows.length) {
      const { error } = await supabase
        .from('bookings')
        .upsert(bookingRows, { onConflict: 'org_id,external_id,external_source' })

      if (error) {
        logger.error(`[Hostex:${userId}] bookings upsert failed: ${error.message}`)
        throw new Error(`Bookings upsert failed: ${error.message}`)
      }
    }

    return { reservationCount: bookingRows.length, revenueEligibleExternalIds: postable }
  })

  // ── 3. Post revenue for confirmed stays ──────────────────────────────────
  if (revenueEligibleExternalIds.length > 0) {
    const revenueEvents = await step.run('fetch-bookings-for-revenue', async () => {
      const supabase = createServiceClient({ system })

      // Paginated AND error-bound. Paginated because this is one row per
      // reservation just imported — sized by the org's booking history, not
      // its property count, so a real portfolio clears max_rows on day one and
      // the rows past 1000 would silently never post revenue. Error-bound
      // because `?? []` on a failed read means ZERO revenue events and a sync
      // that still reports success — a silent financial omission.
      const rows = await fetchAllRows<{ id: string; property_id: string; actual_total_amount: number | null }>(
        (from, to) => supabase
          .from('bookings')
          .select('id, property_id, actual_total_amount')
          .eq('org_id', orgId)
          .eq('external_source', PROVIDER)
          .in('external_id', revenueEligibleExternalIds)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `bookings-for-revenue(hostex)[org=${orgId}]` },
      )

      return rows.map((b) => ({
        name: 'booking/confirmed' as const,
        data: {
          booking_id:          b.id,
          property_id:         b.property_id,
          org_id:              orgId,
          source:              'hostex' as const,
          actual_total_amount: b.actual_total_amount,
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
        logger.error(`[Hostex:${userId}] Turnover generation failed for ${propertyId}: ${err}`)
        reportError(err, { site: 'inngest.hostex-reservation-sync.generate-turnovers' })
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
