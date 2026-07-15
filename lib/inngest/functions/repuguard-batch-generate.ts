import { inngest }                    from '@/lib/inngest/client'
import { createServiceClient }       from '@/lib/supabase/server'
import { generateReviewResponse }    from '@/lib/repuguard/generate-response'
import { getPmEmails }               from '@/lib/inngest/helpers'
import { resend, FROM }              from '@/lib/resend/client'
import { renderPmAlert }             from '@/lib/resend/emails/pm-alert'

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
      const supabase = createServiceClient()

      const { data, error } = await supabase
        .from('reviews')
        .select('id, review_text, rating, guest_name, internal_notes, properties(name)')
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
        const supabase = createServiceClient()

        type PropertyRef = { name?: string } | { name?: string }[] | null
        const propertyRef = review.properties as PropertyRef
        const propertyName = Array.isArray(propertyRef)
          ? (propertyRef[0]?.name ?? 'the property')
          : ((propertyRef as { name?: string } | null)?.name ?? 'the property')

        const guestName     = (review.guest_name as string | null) ?? 'Guest'
        const reviewText    = review.review_text as string
        const starRating    = review.rating as number
        const internalNotes = (review.internal_notes as string | null) ?? null

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

    // ── Notify PM ─────────────────────────────────────────────────────────────
    // Scope the idempotency key to org+date+batch marker (first review id) so a
    // second same-day batch run — triggered after BATCH_LIMIT capped the first —
    // still notifies the PM instead of being silently de-duped.
    const batchRunId = reviews[0]?.id ?? 'empty'

    await step.run('notify-pm', async () => {
      const supabase = createServiceClient()
      const [pmEmail] = await getPmEmails(supabase, org_id)
      if (!pmEmail) return

      const html = await renderPmAlert({
        heading:  'RepuGuard batch complete',
        body:     `${generated} review draft${generated !== 1 ? 's' : ''} are ready for your review.${skipped > 0 ? ' ' + skipped + ' could not be generated and will need to be drafted manually.' : ''}`,
        ctaLabel: 'Review Drafts →',
        ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/reviews`,
      })

      await resend.emails.send(
        { from: FROM, to: pmEmail, subject: `RepuGuard: ${generated} review draft${generated !== 1 ? 's' : ''} ready`, html },
        { idempotencyKey: `repuguard-batch-${org_id}-${new Date().toISOString().split('T')[0]}-${batchRunId}` }
      )
    })

    return { generated, skipped }
  }
)
