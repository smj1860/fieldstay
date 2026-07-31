/**
 * Monthly CapEx Projection Generator (8.16)
 *
 * Cron: 1st of each month at midnight UTC.
 *
 * DISPATCHER ONLY. This used to run `for (const org of orgs) { await
 * step.run(...) }` over a platform-wide `organizations` scan, i.e. one Inngest
 * step per tenant inside a single run — the same shape the 2026-07-30
 * scalability pass converted in six other crons, and the one that hits the
 * per-run step ceiling as tenant count grows (150 tenants = 151 steps in one
 * run, with the whole memoized-state payload re-sent on every one of them, and
 * a single failing tenant retrying the entire tail).
 *
 * Now: one `org/capex_projection.requested` per org, handled by
 * capexProjectionOrg below under its own concurrency cap, so step count per run
 * is 2 regardless of tenant count and a failing tenant retries only itself.
 *
 * The projection math and the org_milestones write live in
 * capex-projection-core.ts, shared with the on-demand button path
 * (capex-projection-trigger.ts) so the two cannot drift.
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { runCapexProjectionForOrg } from '@/lib/inngest/functions/capex-projection-core'

// The payload types are consumed by the capital-planning page, the owner
// portal and the CPA CSV export, which have always imported them from this
// module — re-exported so those import paths keep working unchanged.
export type {
  CapExProjectionItem,
  CapExProjectionYear,
  CapExProjectionPayload,
} from '@/lib/inngest/functions/capex-projection-core'

export const generateCapexProjections = inngest.createFunction(
  {
    id:      'generate-capex-projections',
    name:    'Generate CapEx Projections',
    retries: 2,
  },
  { cron: '0 0 1 * *' },
  async ({ step, logger }) => {
    // Resolved once here and carried on the event so every org in one run is
    // projected against the same year, even if the fan-out straddles midnight
    // on Dec 31.
    const currentYear = new Date().getFullYear()

    const orgIds = await step.run('fetch-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:capex-projections' })
      const rows = await fetchAllRows<{ id: string }>(
        (from, to) => supabase
          .from('organizations')
          .select('id')
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'organizations(capex)' },
      )
      return rows.map((r) => r.id)
    })

    logger.info(`[CapEx] dispatching ${orgIds.length} org(s) for ${currentYear}`)

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-capex-projections',
        orgIds.map((orgId) => ({
          name: 'org/capex_projection.requested' as const,
          data: { org_id: orgId, year: currentYear },
        })),
      )
    }

    return { dispatched: orgIds.length, tax_year: currentYear }
  }
)

/**
 * Per-org CapEx projection. One invocation = one tenant, so the asset and
 * property scans are bounded by that tenant (and paginated regardless — a large
 * org's assets used to run off the end of PostgREST's 1000-row cap and vanish
 * from the projection with no error), and `asset_type_standards` is read once
 * per invocation instead of once per org inside a platform-wide loop.
 */
export const capexProjectionOrg = inngest.createFunction(
  {
    id:          'capex-projection-org',
    name:        'CapEx Projection — per org',
    retries:     2,
    concurrency: { limit: 10 },
  },
  { event: 'org/capex_projection.requested' },
  async ({ event, step, logger }) => {
    const { org_id: orgId, year } = event.data

    const result = await step.run('project-org', async () => {
      const supabase = createServiceClient({ system: 'inngest:capex-projections' })
      return runCapexProjectionForOrg(supabase, orgId, year)
    })

    await step.run('log-projection-audit', async () => {
      await logAuditEvent({
        orgId,
        action:     'asset.capex_projection.triggered',
        targetType: 'org',
        targetId:   orgId,
        metadata:   { source: 'monthly_cron' },
      })
    })

    logger.info(`[CapEx] Org ${orgId}: ${result.years_with_items} replacement years`)
    return { org_id: orgId, tax_year: year, ...result }
  }
)
