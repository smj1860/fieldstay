import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { centralDateKey }      from '@/lib/gtm/policy'
import { enqueueTask, type EnqueueResult } from '@/lib/gtm/tasks'
import { revOpsHandlers, REV_OPS_TASK_TYPES } from '@/lib/gtm/teams/rev-ops'
import { createTeamDrain }     from '@/lib/inngest/functions/gtm-team-drain'

// ============================================================================
// Rev Ops: the work queue, the Monday report, and the on-request report.
//
// The report is queued as a task like any other, so it passes through the same
// switch, cap and approval as everything else. When Rev Ops is off, queueing is
// refused and the cron does nothing: it is safe to leave scheduled.
// ============================================================================

export const gtmRevOpsDrain = createTeamDrain({
  id:       'gtm-rev-ops-drain',
  name:     'GTM Rev Ops: work queue',
  team:     'rev_ops',
  registry: revOpsHandlers,
})

function queueReport(dedupeSuffix: (now: Date) => string): Promise<EnqueueResult> {
  const supabase = createServiceClient({ system: 'inngest:gtm-rev-ops.enqueue' })
  const now = new Date()
  return enqueueTask(supabase, {
    team:             'rev_ops',
    taskType:         REV_OPS_TASK_TYPES.weeklyFunnelReport,
    origin:           'rev_ops',
    requiresApproval: true,
    dedupeKey:        `rev_ops:${REV_OPS_TASK_TYPES.weeklyFunnelReport}:${dedupeSuffix(now)}`,
    now,
  })
}

export const gtmRevOpsWeekly = inngest.createFunction(
  { id: 'cron-gtm-rev-ops-weekly', name: 'Cron: GTM Rev Ops Weekly Report', retries: 2 },
  { cron: '0 13 * * 1' },  // Monday 8am CT (UTC-5)
  async ({ step }) => ({ queued: await step.run('queue-report', () => queueReport(centralDateKey)) }),
)

export const gtmRevOpsManual = inngest.createFunction(
  { id: 'gtm-rev-ops-manual', name: 'GTM Rev Ops: Report on Request', retries: 1 },
  { event: 'gtm/rev-ops.report.requested' },
  async ({ event, step }) => ({
    queued: await step.run('queue-report', () => queueReport(() => `manual:${event.id ?? event.data.requested_by}`)),
  }),
)
