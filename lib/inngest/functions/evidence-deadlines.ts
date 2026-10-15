import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import { sendEventsChunked } from '@/lib/inngest/chunk'
import { createPmNotifications } from '@/lib/inngest/helpers'
import { sweepOrgDeadlines } from '@/lib/evidence/packet/deadline-sweep'

/**
 * Daily dispatcher: one 'evidence/deadlines.requested' per org that has any
 * property. Per-tenant work fans out as events (not a step.run per org) so one
 * large tenant cannot exhaust the dispatcher's step budget.
 */
export const evidenceDeadlinesCron = inngest.createFunction(
  { id: 'cron-evidence-deadlines', name: 'Cron: Evidence Claim Deadlines', retries: 2 },
  { cron: '0 14 * * *' },   // 9am CT: the PM sees the countdown at the start of the day
  async ({ step, logger }) => {
    const nowMs = await step.run('capture-now', async () => Date.now())
    const orgIds = await step.run('find-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-deadlines' })
      return fetchDistinctOrgIds(
        (from, to) => supabase.from('properties').select('org_id').eq('is_active', true)
          .order('org_id', { ascending: true }).range(from, to),
        { label: 'properties(evidence-deadlines)' },
      )
    })
    await sendEventsChunked(step, 'fan-out-evidence-deadlines',
      orgIds.map((orgId) => ({ name: 'evidence/deadlines.requested' as const, data: { org_id: orgId, now_ms: nowMs } })))
    logger.info(`Evidence deadlines: dispatched ${orgIds.length} org(s)`)
    return { dispatched: orgIds.length }
  },
)

/**
 * One org's countdowns. Each (booking, stage) notifies once (dedupe key), so a
 * stay moves from opened to 7 days to 2 days to closed across the daily runs
 * and never repeats a stage.
 */
export const evidenceDeadlinesOrg = inngest.createFunction(
  {
    id: 'evidence-deadlines-org', name: 'Evidence: Claim Deadlines (org)', retries: 2,
    concurrency: [{ limit: 10 }, { limit: 1, key: 'event.data.org_id' }],
  },
  { event: 'evidence/deadlines.requested' },
  async ({ event, step }) => {
    const { org_id: orgId, now_ms: nowMs } = event.data
    return step.run('sweep', async () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-deadlines' })
      const notices = await sweepOrgDeadlines(supabase, { orgId, nowMs })
      await createPmNotifications(supabase, notices)
      return { notices: notices.length }
    })
  },
)

/**
 * Immediate path: a PM or crew member flags a turnover, and the countdown opens
 * now rather than at tomorrow morning's sweep.
 */
export const evidenceDeadlineOnFlag = inngest.createFunction(
  { id: 'evidence-deadline-on-flag', name: 'Evidence: Claim Deadline on Flag', retries: 2 },
  { event: 'turnover/flagged' as const },
  async ({ event, step }) => {
    const { org_id: orgId, turnover_id: turnoverId } = event.data
    return step.run('open-countdown', async () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-deadlines' })
      const notices = await sweepOrgDeadlines(supabase, { orgId, nowMs: Date.now(), onlyTurnoverId: turnoverId })
      await createPmNotifications(supabase, notices)
      return { notices: notices.length }
    })
  },
)
