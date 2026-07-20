import * as Sentry from '@sentry/nextjs'
import { inngest } from '@/lib/inngest/client'
import { resend, FROM } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'

// Functions where a silent failure has direct revenue/data impact — these
// get an email to the founder in addition to the console log every failed
// run already gets below. Exported so a test can assert against it directly
// rather than re-deriving the list of function IDs a founder alert should
// cover.
export const CRITICAL_FUNCTION_IDS = new Set([
  'ownerrez-initial-sync',
  'ownerrez-incremental-sync',
  'work-order-created',

  // Post an owner_transactions ledger entry on completion — the literal
  // "core automation promise" (see CLAUDE.md). A retry-exhausted failure
  // here means a completed turnover/work order/purchase order silently
  // never gets its expense/revenue entry, with nothing else to catch it.
  'turnover-completed',
  'work-order-completed',
  'purchase-order-approved',
])

/**
 * Dead-letter handler — fires whenever ANY Inngest function in this app
 * exhausts its configured retries. `inngest/function.failed` is a built-in
 * Inngest system event, not a custom FieldStayEvents entry.
 */
export const onFunctionFailure = inngest.createFunction(
  { id: 'on-function-failure', name: 'Dead Letter: Function Failure Handler' },
  { event: 'inngest/function.failed' },
  async ({ event, step, logger }) => {
    const { function_id, run_id, error } = event.data
    const errorMessage = error.message ?? 'Unknown error'

    logger.error(`[Inngest Failure] ${function_id} (run ${run_id}) exhausted all retries: ${errorMessage}`)

    // Errors thrown inside an Inngest step are caught by Inngest's own
    // retry/step framework — they never surface as an uncaught exception at
    // the Next.js request level, so Sentry's automatic instrumentation never
    // sees them (the /api/inngest route still returns 200/206 regardless of
    // whether the underlying job succeeded). This dead-letter handler is the
    // one place every function's TERMINAL failure (retries exhausted) is
    // already guaranteed to pass through, so it's the cheapest single point
    // to get real signal into Sentry — rebuild an Error to capture, since
    // Inngest only gives us the serialized name/message/stack, not a live
    // Error instance.
    const sentryError = new Error(`[Inngest] ${function_id} exhausted all retries: ${errorMessage}`)
    if (error.stack) sentryError.stack = error.stack
    Sentry.captureException(sentryError, {
      tags:  { inngest_function_id: function_id },
      extra: { run_id, original_error_name: error.name ?? null },
    })

    if (!CRITICAL_FUNCTION_IDS.has(function_id)) {
      return { function_id, alerted: false }
    }

    await step.run('alert-oncall', async () => {
      await resend.emails.send({
        from:    FROM,
        to:      'stephen@fieldstay.app',
        subject: `🚨 Critical job failed — ${function_id}`,
        html: await renderPmAlert({
          heading:  'Critical background job exhausted retries',
          body:     `${function_id} failed permanently after exhausting all retry attempts.`,
          details: [
            { label: 'Run ID', value: run_id },
            { label: 'Error',  value: errorMessage },
          ],
          ctaLabel: 'Open FieldStay →',
          ctaUrl:   process.env.NEXT_PUBLIC_APP_URL ?? '',
        }),
      })
    })

    return { function_id, alerted: true }
  }
)
