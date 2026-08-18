// lib/inngest/functions/shared/reviews-persist.ts
// ============================================================================
// The write half of every provider's reviews sync: normalized reviews → the
// `reviews` table, then the RepuGuard trigger.
//
// hostex/reviews-sync.ts and hostaway/reviews-sync.ts had ~44 identical lines
// here (SonarQube: 31.9% duplicated on the Hostaway file). The FETCH halves are
// genuinely different — Hostex chunks into sub-180-day windows and has no
// review id, Hostaway takes one `since` and does — but from "I have normalized
// reviews" onward the two were the same code, and the difference between them
// was one field.
//
// That one field is why this takes a `resolveGuestName` hook rather than
// reading `guest_name` off the review: Hostaway's payload carries the guest
// name, and Hostex's does not — it has to be joined out of `bookings` on the
// stay's natural key. Passing a resolver keeps that provider-specific work in
// the provider's file, where its own comment explaining the join lives, while
// the row shape and the upsert conflict target stay in exactly one place.
//
// The conflict target is the part worth having once: reviews are re-read on
// every reconcile sweep, so `onConflict: 'org_id,external_id,external_source'`
// with ignoreDuplicates:false is what makes a re-sync UPDATE an existing row —
// which is how a reply posted inside the provider flips response_status
// locally. Get that wrong in one copy and that provider's replies silently
// stop being noticed.
// ============================================================================

import type { GetStepTools } from 'inngest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import type { SyncLogger } from './reservation-pipeline'

type SyncStep = GetStepTools<typeof inngest>

/**
 * The fields every provider's review normalizer produces.
 *
 * `guest_name` is deliberately absent — see the header. A provider that has it
 * returns it from resolveGuestName; one that doesn't joins for it there.
 */
export interface PersistableReview {
  external_id:          string
  external_source:      string
  /** The provider's own property/listing id, resolved via propertyIdMap. */
  property_external_id: string
  rating:               number
  review_text:          string
  review_date:          string | null
  response_status:      string
  external_url:         string | null
}

export interface PersistReviewsParams<T extends PersistableReview> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the app's clients are untyped; see lib/supabase/server.ts
  supabase: SupabaseClient<any, any, any>
  logger:   SyncLogger
  orgId:    string
  userId:   string
  /** Provider display label for log lines, e.g. 'Hostex'. */
  label:    string
  /** Provider property/listing id (as a string) → FieldStay properties.id. */
  propertyIdMap: Record<string, string>
  normalized:    T[]
  /**
   * The guest name for this review, or null. Called only for reviews whose
   * property resolved, so `propertyId` is safe to key a lookup on.
   */
  resolveGuestName: (review: T, propertyId: string) => string | null
}

/**
 * Maps normalized reviews onto `reviews` rows and upserts them.
 *
 * Returns the row count written. Throws on an upsert error — a swallowed
 * failure here is a provider whose reviews silently never arrive.
 */
export async function persistNormalizedReviews<T extends PersistableReview>(
  params: PersistReviewsParams<T>,
): Promise<number> {
  const { supabase, logger, orgId, userId, label, propertyIdMap, normalized, resolveGuestName } = params

  const rows = normalized
    .map((r) => {
      const propertyId = propertyIdMap[r.property_external_id]

      // A review for a property we never imported. Skipped LOUDLY, the same as
      // the reservation pipeline's unmapped-property guard: reviews.property_id
      // is nullable, but a review floating free of its property is invisible in
      // a UI that lists per property.
      if (!propertyId) {
        logger.warn(
          `[${label}:${userId}] Skipping review ${r.external_id} — ` +
          `no FieldStay property for ${label} property ${r.property_external_id}`
        )
        return null
      }

      return {
        org_id:          orgId,
        property_id:     propertyId,
        external_id:     r.external_id,
        external_source: r.external_source,
        external_url:    r.external_url,
        guest_name:      resolveGuestName(r, propertyId),
        rating:          r.rating,
        review_text:     r.review_text,
        review_date:     r.review_date,
        response_status: r.response_status,
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)

  if (!rows.length) return 0

  // ignoreDuplicates:false on purpose — a re-sync must UPDATE, so that a reply
  // posted inside the provider flips response_status here. See the header.
  const { error } = await supabase
    .from('reviews')
    .upsert(rows, { onConflict: 'org_id,external_id,external_source', ignoreDuplicates: false })

  if (error) {
    logger.error(`[${label}:${userId}] reviews upsert failed: ${error.message}`)
    throw new Error(`Reviews upsert failed: ${error.message}`)
  }

  return rows.length
}

/**
 * Fires RepuGuard batch generation for an org that just received reviews.
 *
 * A synced review that never gets a draft is a review the PM has to notice and
 * click Generate on. Hostex shipped without this and reviews landed in the
 * table and stopped there — RepuGuard silently did nothing for a whole
 * provider. Firing from the shared sync path rather than from each of the
 * three or four call sites (initial sync, daily reconcile, review webhook) is
 * what makes it impossible for the next caller to forget.
 *
 * ⚠️ Top-level step tooling — the caller must NOT invoke this inside a
 * step.run() body. See the Inngest constraints in CLAUDE.md.
 *
 * Safe to fire per sync: repuguardBatchGenerate is serialised per org
 * (concurrency limit 1 keyed on org_id) and selects only rows still at
 * response_status = 'pending', so a reconcile that re-upserts unchanged reviews
 * costs one no-op run rather than duplicate drafts.
 */
export async function triggerRepuGuardForReviews(params: {
  step:        SyncStep
  stepId:      string
  orgId:       string
  requestedBy: string
  reviewCount: number
}): Promise<void> {
  const { step, stepId, orgId, requestedBy, reviewCount } = params
  if (reviewCount <= 0) return

  await step.sendEvent(stepId, {
    name: 'repuguard/batch_generate.requested' as const,
    data: { org_id: orgId, requested_by: requestedBy },
  })
}
