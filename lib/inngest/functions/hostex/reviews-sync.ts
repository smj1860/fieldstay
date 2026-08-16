// lib/inngest/functions/hostex/reviews-sync.ts
// ============================================================================
// Hostex reviews → the `reviews` table.
//
// Three callers, one implementation: the initial-sync backfill, the daily
// reconcile sweep, and a review_created/review_updated webhook naming one
// reservation.
//
// TWO HOSTEX CONSTRAINTS SHAPE THIS:
//
//   1. A /reviews date range must be UNDER 180 days. A 12-month backfill is
//      therefore several requests, not one — see hostexReviewWindows.
//
//   2. There is no review id, and no stay_code either — so a review is keyed
//      by (reservation_code, property_id). bookings are keyed by STAY_CODE,
//      which a review never carries, so the guest-name backfill joins on the
//      natural key the review does carry: property + check-in + check-out.
//      That triple identifies the stay exactly, and unlike a code join it
//      cannot be broken by the two endpoints disagreeing about identity.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest }            from '@/lib/inngest/client'
import { fetchAllRows }       from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import {
  hostexFetchReviews,
  hostexFetchReviewByReservation,
  hostexReviewWindows,
} from '@/lib/integrations/providers/hostex-api'
import { hostexReviewToNormalized } from '@/lib/integrations/providers/hostex.mappers'
import type { HostexReview } from '@/lib/integrations/providers/hostex.types'
import type { SyncLogger } from '../shared/reservation-pipeline'

const PROVIDER = 'hostex'

type SyncStep = GetStepTools<typeof inngest>

export type HostexReviewFetchMode =
  /** Sweep a span of history, chunked into legal windows. */
  | { kind: 'window'; historyMonths: number }
  /** One reservation, named by a webhook delivery. */
  | { kind: 'reservation'; reservationCode: string }

export interface HostexReviewSyncParams {
  step:   SyncStep
  logger: SyncLogger
  token:  string
  orgId:  string
  userId: string
  /** Hostex property id (as a string) → FieldStay properties.id. */
  propertyIdMap: Record<string, string>
  fetchMode:     HostexReviewFetchMode
  system:        string
  /** Distinguishes this call's Inngest step ids from a sibling call's. */
  stepPrefix:    string
}

export async function syncHostexReviews(
  params: HostexReviewSyncParams,
): Promise<{ reviewCount: number }> {
  const { step, logger, token, orgId, userId, propertyIdMap, fetchMode, system, stepPrefix } = params

  if (!Object.keys(propertyIdMap).length) return { reviewCount: 0 }

  // ── 1. Fetch ─────────────────────────────────────────────────────────────
  const reviews = await step.run(`${stepPrefix}-fetch-reviews`, async (): Promise<HostexReview[]> => {
    if (fetchMode.kind === 'reservation') {
      const one = await hostexFetchReviewByReservation(token, userId, fetchMode.reservationCode)
      return one ? [one] : []
    }

    // Sequential rather than concurrent: these all spend the same
    // per-connection Hostex budget, and a backfill is not latency-sensitive.
    const collected: HostexReview[] = []
    for (const window of hostexReviewWindows(fetchMode.historyMonths)) {
      collected.push(...await hostexFetchReviews(token, userId, window))
    }
    return collected
  })

  logger.info(`[Hostex:${userId}] Fetched ${reviews.length} review records`)

  // ── 2. Upsert ────────────────────────────────────────────────────────────
  const reviewCount = await step.run(`${stepPrefix}-upsert-reviews`, async () => {
    const normalized = reviews
      .map(hostexReviewToNormalized)
      .filter((r): r is NonNullable<typeof r> => r !== null)

    if (!normalized.length) return 0

    const supabase = createServiceClient({ system })

    // Guest names are not on the review payload. Joined on the stay's natural
    // key — property + check-in + check-out — because the review carries no
    // stay_code and bookings.external_id IS the stay_code. One bounded read,
    // rather than leaving every Hostex review anonymous in the UI.
    const propertyIds  = [...new Set(Object.values(propertyIdMap))]
    const checkoutDates = normalized.map((r) => r.checkout_date).filter(Boolean)

    const bookings = checkoutDates.length
      ? await fetchAllRows<{ property_id: string; checkin_date: string; checkout_date: string; guest_name: string | null }>(
          (from, to) => supabase
            .from('bookings')
            .select('property_id, checkin_date, checkout_date, guest_name')
            .eq('org_id', orgId)
            .eq('external_source', PROVIDER)
            .in('property_id', propertyIds)
            .gte('checkout_date', checkoutDates.reduce((a, b) => (a < b ? a : b)))
            .lte('checkout_date', checkoutDates.reduce((a, b) => (a > b ? a : b)))
            .order('property_id', { ascending: true })
            .range(from, to),
          { label: `hostex-reviews.guest-names[org=${orgId}]` },
        )
      : []

    const stayKey = (propertyId: string, checkin: string, checkout: string) =>
      `${propertyId}|${checkin}|${checkout}`

    const guestNameByStay = new Map(
      bookings.map((b) => [stayKey(b.property_id, b.checkin_date, b.checkout_date), b.guest_name]),
    )

    const rows = normalized
      .map((r) => {
        const propertyId = propertyIdMap[r.property_external_id]

        // A review for a property we have not imported. Skipped loudly, same
        // as the reservation pipeline's unmapped-property guard — reviews.
        // property_id is nullable, but a review floating free of its property
        // is invisible in a UI that lists per property.
        if (!propertyId) {
          logger.warn(
            `[Hostex:${userId}] Skipping review for reservation ${r.external_id} — ` +
            `no FieldStay property for Hostex property ${r.property_external_id}`
          )
          return null
        }

        return {
          org_id:          orgId,
          property_id:     propertyId,
          external_id:     r.external_id,
          external_source: r.external_source,
          external_url:    r.external_url,
          guest_name:      guestNameByStay.get(stayKey(propertyId, r.checkin_date, r.checkout_date)) ?? null,
          rating:          r.rating,
          review_text:     r.review_text,
          review_date:     r.review_date,
          response_status: r.response_status,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)

    if (!rows.length) return 0

    const { error } = await supabase
      .from('reviews')
      .upsert(rows, { onConflict: 'org_id,external_id,external_source', ignoreDuplicates: false })

    if (error) {
      logger.error(`[Hostex:${userId}] reviews upsert failed: ${error.message}`)
      throw new Error(`Reviews upsert failed: ${error.message}`)
    }

    return rows.length
  })

  return { reviewCount }
}
