/**
 * On-Demand CapEx Projection for a single org (CLAUDE_57_0)
 *
 * Triggered by: 'asset/capex-projection-requested'
 * Fired from:   capital-planning/actions.ts::triggerCapexProjections()
 *               which requires org membership before firing.
 *
 * Shares runCapexProjectionForOrg with the monthly cron's per-org handler, so
 * the button and the cron produce a byte-identical org_milestones payload by
 * construction rather than by two copies of the math staying in sync.
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { runCapexProjectionForOrg } from '@/lib/inngest/functions/capex-projection-core'

export const triggerCapexProjectionForOrg = inngest.createFunction(
  {
    id:      'trigger-capex-projection-for-org',
    name:    'CapEx Projection: On-Demand (Single Org)',
    retries: 2,
  },
  { event: 'asset/capex-projection-requested' },
  async ({ event, step, logger }) => {
    const { org_id } = event.data
    const currentYear = new Date().getFullYear()

    const result = await step.run('project-org', async () => {
      const supabase = createServiceClient({ system: 'inngest:capex-projection-trigger' })
      return runCapexProjectionForOrg(supabase, org_id, currentYear)
    })

    logger.info(`[CapEx on-demand] org=${org_id} years=${result.years_with_items} assets=${result.total_assets}`)
    return { org_id, ...result }
  }
)
