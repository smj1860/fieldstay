import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }         from '@/lib/observability/report-error'
import { IN_PROGRESS_STALL_MINUTES } from '@/lib/gtm/constants'

// ============================================================================
// Puts back work a worker abandoned.
//
// A task claimed by a worker that then died (a deploy, a timeout, a crash)
// would sit in 'in_progress' forever: nothing else will ever touch it, and the
// team believes it is being handled. This finds anything claimed longer ago
// than IN_PROGRESS_STALL_MINUTES and either requeues it or, once it has used
// its attempts, marks it failed.
//
// The work is one atomic UPDATE inside gtm_sweep_stalled_tasks() rather than a
// read followed by a write per row, so two sweeps overlapping cannot move the
// same task twice. It touches no external system and writes nothing a person
// reads, which is why it needs no switch: it only ever repairs the queue.
// ============================================================================

interface SweepResult { requeued: number; failed: number }

function parseSweep(raw: unknown): SweepResult {
  const obj = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return { requeued: num(obj.requeued), failed: num(obj.failed) }
}

export const gtmTaskStallSweep = inngest.createFunction(
  { id: 'cron-gtm-stall-sweep', name: 'Cron: GTM Stalled-Task Sweep', retries: 1 },
  { cron: '*/15 * * * *' },
  async ({ step, logger }) => {
    const result = await step.run('sweep', async (): Promise<SweepResult> => {
      const supabase = createServiceClient({ system: 'inngest:gtm-stall-sweep' })
      const claimedBefore = new Date(Date.now() - IN_PROGRESS_STALL_MINUTES * 60_000)

      const { data, error } = await supabase.rpc('gtm_sweep_stalled_tasks', {
        p_claimed_before: claimedBefore.toISOString(),
      })
      if (error) {
        reportError(error, { site: 'inngest.gtm-stall-sweep.sweep' })
        throw error
      }
      return parseSweep(data)
    })

    // A task failing for good is a signal rather than a fault: the retry budget
    // did its job. Worth seeing, not worth a page.
    if (result.failed > 0) {
      reportError(new Error('GTM tasks failed after stalling'), {
        site:  'inngest.gtm-stall-sweep',
        level: 'warning',
        extra: { failed: result.failed, requeued: result.requeued },
      })
    }

    logger.info(`GTM stall sweep: requeued ${result.requeued}, failed ${result.failed}`)
    return result
  },
)
