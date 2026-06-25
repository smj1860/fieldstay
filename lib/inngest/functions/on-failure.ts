import { inngest } from '@/lib/inngest/client'
import { resend, FROM } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'

// Functions where a silent failure has direct revenue/data impact — these
// get an email to the founder in addition to the console log every failed
// run already gets below.
const CRITICAL_FUNCTION_IDS = new Set([
  'ownerrez-initial-sync',
  'ownerrez-incremental-sync',
  'work-order-created',
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
