import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { recordGauge } from '@/lib/observability/metrics'
import type { WoStatus, ComplianceStatus } from '@/types/database'

const OPEN_WO_STATUSES: WoStatus[] = ['pending', 'quote_requested', 'assigned', 'in_progress']

function tally<K extends string>(values: K[]): Record<K, number> {
  const counts = {} as Record<K, number>
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

/**
 * SCHEDULED: runs every 30 minutes.
 *
 * Platform-wide (not per-org) point-in-time snapshot of a handful of
 * operational health numbers, pushed to Grafana Cloud as gauges. This is
 * the first FieldStay-specific data to reach Grafana — everything else in
 * that Grafana Cloud instance today is stock Supabase/Vercel infra
 * metrics, not app-level business data.
 *
 * Platform-wide rather than per-org to keep OTLP series cardinality flat
 * as the org count grows — see the "GrafanaCloud > Cardinality
 * management" dashboards already in this Grafana Cloud instance. Per-org
 * breakdowns belong in per-org event counters (see turnover-events.ts,
 * work-order-crew-completed.ts) where cardinality is naturally bounded by
 * event volume, not by every org getting its own always-on timeseries.
 */
export const metricsSnapshot = inngest.createFunction(
  { id: 'cron-metrics-snapshot', name: 'Cron: Grafana Metrics Snapshot', retries: 2 },
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    await step.run('work-order-backlog', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('work_orders')
        .select('status')
        .in('status', OPEN_WO_STATUSES)

      const counts = tally((data ?? []).map((wo) => wo.status))
      for (const status of OPEN_WO_STATUSES) {
        await recordGauge('fieldstay_work_orders_backlog', counts[status] ?? 0, { status })
      }
    })

    await step.run('inventory-below-par', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('inventory_items')
        .select('current_quantity, par_level, first_count_recorded_at')

      // Items never counted default current_quantity to 0, which would
      // otherwise look "below par" on every freshly-added item — same
      // exclusion build-shopping-cart.ts applies before auto-cart building.
      const belowPar = (data ?? []).filter(
        (item) => item.first_count_recorded_at && (item.current_quantity ?? 0) < (item.par_level ?? 1)
      ).length

      await recordGauge('fieldstay_inventory_below_par_count', belowPar)
    })

    await step.run('vendor-compliance-status', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('vendor_compliance_status')
        .select('compliance_status')

      const statuses: ComplianceStatus[] = ['compliant', 'expiring_soon', 'grace_period', 'hard_blocked', 'no_documents']
      const counts = tally(
        (data ?? [])
          .map((row) => row.compliance_status)
          .filter((s): s is ComplianceStatus => s !== null)
      )
      for (const status of statuses) {
        await recordGauge('fieldstay_vendor_compliance_status_count', counts[status] ?? 0, { status })
      }
    })

    return { ranAt: new Date().toISOString() }
  }
)
