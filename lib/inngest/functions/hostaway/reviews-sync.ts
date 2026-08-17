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
import { hostawayFetchReviews } from '@/lib/integrations/providers/hostaway'
import { hostawayReviewToNormalized } from '@/lib/integrations/providers/hostaway.mappers'
import type { SyncLogger } from '../shared/reservation-pipeline'
import { hostawayHistoryCutoff } from './reservation-sync'

type SyncStep = GetStepTools<typeof inngest>

export interface HostawayReviewSyncParams {
  step:   SyncStep
  logger: SyncLogger
  token:  string
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
  const { step, logger, token, orgId, userId, propertyIdMap, historyMonths, system, stepPrefix } = params

  const reviewCount = await step.run(`${stepPrefix}-sync-reviews`, async () => {
    if (!Object.keys(propertyIdMap).length) return 0

    const raw = await hostawayFetchReviews(token, hostawayHistoryCutoff(historyMonths))
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

    const rows = normalized
      .map((r) => {
        const propertyId = propertyIdMap[r.property_external_id]

        // A review for a listing we never imported. Skipped LOUDLY, the same
        // as the reservation pipeline's unmapped-property guard:
        // reviews.property_id is nullable, but a review floating free of its
        // property is invisible in a UI that lists per property.
        if (!propertyId) {
          logger.warn(
            `[Hostaway:${userId}] Skipping review ${r.external_id} — ` +
            `no FieldStay property for Hostaway listing ${r.property_external_id}`
          )
          return null
        }

        return {
          org_id:          orgId,
          property_id:     propertyId,
          external_id:     r.external_id,
          external_source: r.external_source,
          external_url:    r.external_url,
          guest_name:      r.guest_name,
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
      logger.error(`[Hostaway:${userId}] reviews upsert failed: ${error.message}`)
      throw new Error(`Reviews upsert failed: ${error.message}`)
    }

    return rows.length
  })

  // A synced review that never gets a draft is a review the PM has to notice
  // and click Generate on. Fired HERE rather than at each call site so a third
  // caller cannot forget it — the same reasoning, and the same defect history,
  // as hostex/reviews-sync.ts, where reviews landed in the table and stopped
  // there and RepuGuard silently did nothing for a whole provider.
  //
  // Top-level step tooling, never inside the step.run above — see the Inngest
  // constraints in CLAUDE.md.
  //
  // Safe to fire per sync: repuguardBatchGenerate is serialised per org
  // (concurrency limit 1 keyed on org_id) and selects only rows still at
  // response_status = 'pending', so a reconcile that re-upserts unchanged
  // reviews costs one no-op run rather than duplicate drafts.
  if (reviewCount > 0) {
    await step.sendEvent(`${stepPrefix}-trigger-repuguard`, {
      name: 'repuguard/batch_generate.requested' as const,
      data: { org_id: orgId, requested_by: `hostaway-${stepPrefix}` },
    })
  }

  return { reviewCount }
}
