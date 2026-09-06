import * as Sentry from '@sentry/nextjs'
import { inngest } from '@/lib/inngest/client'
import { resend, FROM } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { isReconnectRequired, stripReconnectRequiredMarker } from '@/lib/inngest/reconnect-required'

// Functions where a silent failure has direct revenue/data impact — these
// get an email to the founder in addition to the console log every failed
// run already gets below. Exported so a test can assert against it directly
// rather than re-deriving the list of function IDs a founder alert should
// cover.
export const CRITICAL_FUNCTION_IDS = new Set([
  'ownerrez-initial-sync',
  'ownerrez-incremental-sync',
  // Per-connection sync handler (the incremental-sync dispatcher fans out to
  // it) — terminal failures here are the actual sync failures now.
  'ownerrez-connection-sync',
  'work-order-created',

  // Post an owner_transactions ledger entry on completion — the literal
  // "core automation promise" (see CLAUDE.md). A retry-exhausted failure
  // here means a completed turnover/work order/purchase order silently
  // never gets its expense/revenue entry, with nothing else to catch it.
  'turnover-completed',
  'work-order-completed',
  'purchase-order-approved',

  // The destructive half of account deletion. A terminal failure here leaves a
  // half-purged organization with no auth user able to re-drive it — the
  // orphaned-tenant outcome that was actually found in production on
  // 2026-07-30 (two orgs, 10 properties, 20 bookings carrying guest PII). The
  // user cannot retry: their session is gone. This alert is the only path back.
  'account-deletion',
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
    const rawMessage = error.message ?? 'Unknown error'

    // A provider has stopped accepting one customer's credential. Terminal,
    // but not a fault of ours and not something a retry, an alert or an
    // on-call engineer can change — only that PM reconnecting can, and they
    // have already been told (throttled) by the sync that raised this. See
    // lib/inngest/reconnect-required.ts for why the marker is in the message.
    const reconnect    = isReconnectRequired(rawMessage)
    const errorMessage = stripReconnectRequiredMarker(rawMessage)

    if (reconnect) {
      logger.warn(`[Inngest Failure] ${function_id} (run ${run_id}) stopped — reconnect required: ${errorMessage}`)
    } else {
      logger.error(`[Inngest Failure] ${function_id} (run ${run_id}) exhausted all retries: ${errorMessage}`)
    }

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
    //
    // "exhausted all retries" is only true for a failure that actually ran the
    // retry policy. A reconnect-required failure is raised as a
    // NonRetriableError, which opts out of it entirely — so the old wording
    // asserted attempts that were never made, on a class of event where the
    // right reading is "waiting on the customer", not "we are broken". It goes
    // in at warning level for the same reason.
    const sentryError = reconnect
      ? new Error(`[Inngest] ${function_id} stopped — reconnect required: ${errorMessage}`)
      : new Error(`[Inngest] ${function_id} exhausted all retries: ${errorMessage}`)
    if (error.stack) sentryError.stack = error.stack
    Sentry.captureException(sentryError, {
      level: reconnect ? 'warning' : 'error',
      tags:  {
        inngest_function_id: function_id,
        // Indexed, so the reconnect backlog can be filtered out of (or listed
        // on its own from) the real failures without reading every title.
        failure_kind: reconnect ? 'reconnect_required' : 'retries_exhausted',
      },
      extra: { run_id, original_error_name: error.name ?? null },
    })

    // A founder page is for something only we can fix. A lapsed customer
    // authorization is not that, however critical the function carrying it —
    // one OwnerRez grant expiring used to send a "🚨 Critical job failed"
    // email for a condition the PM had already been emailed about and is the
    // only person who can resolve.
    if (reconnect || !CRITICAL_FUNCTION_IDS.has(function_id)) {
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
      }, { idempotencyKey: `critical-job-failed-${run_id}` })
    })

    return { function_id, alerted: true }
  }
)
