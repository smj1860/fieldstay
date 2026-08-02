import { inngest }                    from '@/lib/inngest/client'
import { createServiceClient }       from '@/lib/supabase/server'
import { generateReviewResponse }    from '@/lib/repuguard/generate-response'
import { unwrapJoin }                from '@/lib/utils/supabase-joins'

import { reportError } from '@/lib/observability/report-error'
const BATCH_LIMIT = 25

export const repuguardBatchGenerate = inngest.createFunction(
  {
    id:      'repuguard-batch-generate',
    name:    'RepuGuard: Batch Generate Review Drafts',
    retries: 1,
  },
  { event: 'repuguard/batch_generate.requested' as const },
  async ({ event, step, logger }) => {
    const { org_id } = event.data

    // ── Step 1: Fetch pending reviews ─────────────────────────────────────────
    const reviews = await step.run('fetch-pending-reviews', async () => {
      const supabase = createServiceClient({ system: 'inngest:repuguard-batch-generate' })

      const { data, error } = await supabase
        .from('reviews')
        // `internal_notes` is NOT selected: there is no such column on
        // `reviews` (verified against the live API — PostgREST answers
        // `42703 column reviews.internal_notes does not exist`). Naming it
        // here made PostgREST reject the WHOLE select, so `error` was always
        // set and the throw below fired on every run, for every org — batch
        // generation had never produced a single draft. See the note at the
        // internalNotes assignment below.
        .select('id, review_text, rating, guest_name, properties(name)')
        .eq('org_id', org_id)
        .eq('response_status', 'pending')
        .order('created_at', { ascending: true })
        .limit(BATCH_LIMIT)

      if (error) throw new Error(`Failed to fetch pending reviews: ${error.message}`)
      return data ?? []
    })

    logger.info(`RepuGuard batch: ${reviews.length} pending reviews for org ${org_id}`)

    if (!reviews.length) {
      return { generated: 0, skipped: 0 }
    }

    // ── Steps 2+: Generate response per review ────────────────────────────────
    // Accumulate outcomes from step return values rather than mutating outer
    // counters inside step.run — memoized steps don't re-run their callbacks on
    // replay, so in-callback counter mutations would undercount.
    const results: Array<{ generated: boolean }> = []

    for (const review of reviews) {
      const result = await step.run(`generate-${review.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:repuguard-batch-generate' })

        type PropertyRef = { name?: string } | { name?: string }[] | null
        const propertyRef = review.properties as PropertyRef
        const propertyName = unwrapJoin(propertyRef)?.name ?? 'the property'

        const guestName     = (review.guest_name as string | null) ?? 'Guest'
        const reviewText    = review.review_text as string
        const starRating    = review.rating as number
        // Always null, deliberately and visibly. generateReviewResponse()
        // supports internal notes (it sanitises and truncates them into the
        // prompt), but `reviews` has no internal_notes column and nothing in
        // the codebase writes one — the only internal_notes that exists is on
        // `properties`. The capability is kept wired so that adding the column
        // plus a way to populate it is the whole change; what is removed is
        // the pretence that it is already being read.
        const internalNotes: string | null = null

        let parsed
        try {
          parsed = await generateReviewResponse({
            reviewText,
            starRating,
            propertyName,
            guestName,
            internalNotes,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const isTransient = msg.includes('rate') || msg.includes('timeout') ||
                              msg.includes('503') || msg.includes('429') ||
                              msg.includes('network')

          if (isTransient) {
            // Re-throw transient errors so the step.run retries them
            // (each review is its own step.run, so this only retries that review)
            logger.warn(`RepuGuard batch: transient failure for review ${review.id}, will retry: ${msg}`)
            reportError(err, { site: 'inngest.repuguard-batch-generate.fetch-pending-reviews' })
            throw err
          }

          // Permanent failure (malformed review, missing fields, etc.)
          logger.error(`RepuGuard batch: permanent failure for review ${review.id}: ${msg}`)
          return { generated: false }
        }

        const hasFlags     = Array.isArray(parsed.flags) && parsed.flags.length > 0
        const responseStatus = hasFlags ? 'draft' : 'ready'

        await supabase.from('review_responses').upsert({
          review_id:          review.id,
          org_id,
          generated_response: parsed.response,
          edited_response:    null,
          word_count:         parsed.word_count,
          tone_used:          parsed.tone_used,
          flags:              parsed.flags ?? [],
          flag_reason:        parsed.flag_reason ?? null,
          generated_at:       new Date().toISOString(),
        }, { onConflict: 'review_id' })

        await supabase
          .from('reviews')
          .update({ response_status: responseStatus, updated_at: new Date().toISOString() })
          .eq('id', review.id)

        return { generated: true }
      })

      // result is null only if the step was skipped/failed terminally — count as skipped
      results.push(result ?? { generated: false })

      if (reviews.indexOf(review) < reviews.length - 1) {
        await step.sleep(`pace-${review.id}`, '500ms')
      }
    }

    const generated = results.filter((r) => r.generated).length
    const skipped   = results.filter((r) => !r.generated).length

    // PM notification for generated drafts is now a once-daily digest —
    // see lib/inngest/functions/cron/notification-digest.ts. Nothing to
    // do here per-batch; review_responses.generated_at is what the digest
    // cron counts.

    return { generated, skipped }
  }
)
