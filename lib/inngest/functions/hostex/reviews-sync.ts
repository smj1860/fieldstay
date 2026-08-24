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
import { persistNormalizedReviews, triggerRepuGuardForReviews } from '../shared/reviews-persist'
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
  /**
   * Acquires a CURRENT token. A getter, not a token — see the "credentials are
   * not step state" note in lib/integrations/providers/hospitable-token.ts.
   * Resolving it once would let Inngest memoize it into step state and replay
   * it on every retry, so a token invalidated mid-run could never be recovered.
   */
  getToken: () => Promise<string>
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
  const { step, logger, getToken, orgId, userId, propertyIdMap, fetchMode, system, stepPrefix } = params

  if (!Object.keys(propertyIdMap).length) return { reviewCount: 0 }

  // ── 1. Fetch ─────────────────────────────────────────────────────────────
  const reviews = await step.run(`${stepPrefix}-fetch-reviews`, async (): Promise<HostexReview[]> => {
    if (fetchMode.kind === 'reservation') {
      const one = await hostexFetchReviewByReservation(await getToken(), userId, fetchMode.reservationCode)
      return one ? [one] : []
    }

    // Sequential rather than concurrent: these all spend the same
    // per-connection Hostex budget, and a backfill is not latency-sensitive.
    const collected: HostexReview[] = []
    for (const window of hostexReviewWindows(fetchMode.historyMonths)) {
      collected.push(...await hostexFetchReviews(await getToken(), userId, window))
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
    const propertyIds = [...new Set(Object.values(propertyIdMap))]

    // ISO-8601 dates sort lexicographically, so a plain sort gives the range
    // bounds. Deliberately NOT Math.min/Math.max, which SonarQube suggests for
    // the equivalent ternary reduce: these are STRINGS, and Math.min coerces
    // them to NaN — the query would then bound on NaN and silently match
    // nothing, taking every guest name with it.
    const checkoutDates = normalized
      .map((r) => r.checkout_date)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))

    const bookings = checkoutDates.length
      ? await fetchAllRows<{ property_id: string; checkin_date: string; checkout_date: string; guest_name: string | null }>(
          (from, to) => supabase
            .from('bookings')
            .select('property_id, checkin_date, checkout_date, guest_name')
            .eq('org_id', orgId)
            .eq('external_source', PROVIDER)
            .in('property_id', propertyIds)
            .gte('checkout_date', checkoutDates[0]!)
            .lte('checkout_date', checkoutDates.at(-1)!)
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

    return persistNormalizedReviews({
      supabase, logger, orgId, userId,
      label: 'Hostex',
      propertyIdMap,
      normalized,
      // Hostex reviews carry no guest name — it comes from the bookings join
      // above, keyed on the stay's natural key. See shared/reviews-persist.ts
      // for why this is a hook rather than a `guest_name` field.
      resolveGuestName: (r, propertyId) =>
        guestNameByStay.get(stayKey(propertyId, r.checkin_date, r.checkout_date)) ?? null,
    })
  })

  // Top-level step tooling, never inside the step.run above — see the Inngest
  // constraints in CLAUDE.md.
  await triggerRepuGuardForReviews({
    step,
    stepId:      `${stepPrefix}-trigger-repuguard`,
    orgId,
    requestedBy: `hostex-${stepPrefix}`,
    reviewCount,
  })

  return { reviewCount }
}
