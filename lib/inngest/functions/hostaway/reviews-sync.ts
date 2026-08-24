// lib/inngest/functions/hostaway/reviews-sync.ts
// ============================================================================
// Hostaway reviews → the `reviews` table → RepuGuard.
//
// Two callers, one implementation: the initial-sync backfill and the daily
// reconcile sweep. A third (a review webhook) fits the same shape when that
// phase lands.
//
// SIMPLER THAN THE HOSTEX EQUIVALENT, in two ways worth naming because they
// are why this file is half the length:
//
//   1. A Hostaway review has a real `id`, so external_id is that id. Hostex
//      has none and has to key on (reservation_code, property_id).
//   2. A Hostaway review carries `guestName` directly. Hostex's does not, so
//      it back-fills the name by joining bookings on
//      property + check-in + check-out. No join is needed here.
//
// The date window is one request range rather than chunked windows — Hostaway
// imposes no <180-day limit on /reviews the way Hostex does on its equivalent.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { persistNormalizedReviews, triggerRepuGuardForReviews } from '../shared/reviews-persist'
import { hostawayFetchReviews } from '@/lib/integrations/providers/hostaway'
import { hostawayReviewToNormalized } from '@/lib/integrations/providers/hostaway.mappers'
import type { SyncLogger } from '../shared/reservation-pipeline'
import { hostawayHistoryCutoff } from './reservation-sync'

type SyncStep = GetStepTools<typeof inngest>

export interface HostawayReviewSyncParams {
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
  /** Hostaway listing id (as a string) → FieldStay properties.id. */
  propertyIdMap: Record<string, string>
  /** How far back to sweep, in months. */
  historyMonths: number
  /** Names the RLS bypass for createServiceClient — see ServiceRoleContext. */
  system:        string
  /** Distinguishes this call's Inngest step ids from a sibling call's. */
  stepPrefix:    string
}

export async function syncHostawayReviews(
  params: HostawayReviewSyncParams,
): Promise<{ reviewCount: number }> {
  const { step, logger, getToken, orgId, userId, propertyIdMap, historyMonths, system, stepPrefix } = params

  const reviewCount = await step.run(`${stepPrefix}-sync-reviews`, async () => {
    if (!Object.keys(propertyIdMap).length) return 0

    const raw = await hostawayFetchReviews(await getToken(), hostawayHistoryCutoff(historyMonths))
    logger.info(`[Hostaway:${userId}] Fetched ${raw.length} reviews`)

    // Most of what comes back is dropped here, and that is the normal case:
    // Hostaway returns a row from the moment a review is SCHEDULED, with no
    // rating and no text. See hostawayReviewToNormalized for why the guard is
    // on content rather than on the status name.
    const normalized = raw
      .map(hostawayReviewToNormalized)
      .filter((r): r is NonNullable<typeof r> => r !== null)

    if (!normalized.length) return 0

    const supabase = createServiceClient({ system })

    return persistNormalizedReviews({
      supabase, logger, orgId, userId,
      label: 'Hostaway',
      propertyIdMap,
      normalized,
      // Hostaway puts the guest name on the review payload itself — no join,
      // unlike Hostex. See shared/reviews-persist.ts for why this is a hook.
      resolveGuestName: (r) => r.guest_name,
    })
  })

  // Top-level step tooling, never inside the step.run above — see the Inngest
  // constraints in CLAUDE.md.
  await triggerRepuGuardForReviews({
    step,
    stepId:      `${stepPrefix}-trigger-repuguard`,
    orgId,
    requestedBy: `hostaway-${stepPrefix}`,
    reviewCount,
  })

  return { reviewCount }
}
