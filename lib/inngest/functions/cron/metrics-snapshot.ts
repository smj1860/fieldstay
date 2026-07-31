import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { recordGauge } from '@/lib/observability/metrics'
import type { WoStatus, ComplianceStatus } from '@/types/database'

const OPEN_WO_STATUSES: WoStatus[] = ['pending', 'quote_requested', 'assigned', 'in_progress']
const COMPLIANCE_STATUSES: ComplianceStatus[] = [
  'compliant', 'expiring_soon', 'grace_period', 'hard_blocked', 'no_documents',
]

/**
 * SCHEDULED: runs every 30 minutes.
 *
 * Platform-wide (not per-org) point-in-time snapshot of a handful of
 * operational health numbers, sent to Sentry as Application Metrics gauges
 * via lib/observability/metrics.ts.
 *
 * Every gauge is computed by a SQL aggregate — no rows cross the wire. The
 * original implementation selected whole tables (work_orders, inventory_items
 * ≈ 500,000 rows at 150 tenants, vendor_compliance_status) and tallied them in
 * JS. PostgREST caps every response at max_rows (1000) with no error, so each
 * of those gauges would have flat-lined at an arbitrary fraction of the real
 * number — a metric that reads plausible and is wrong is worse than no metric,
 * because it is exactly what gets trusted during an incident.
 *
 * Platform-wide rather than per-org to keep metric-attribute cardinality flat
 * as the org count grows. Per-org breakdowns belong in per-org event counters
 * (see turnover-events.ts, work-order-crew-completed.ts) where cardinality is
 * naturally bounded by event volume.
 */
export const metricsSnapshot = inngest.createFunction(
  { id: 'cron-metrics-snapshot', name: 'Cron: Metrics Snapshot', retries: 2 },
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    await step.run('work-order-backlog', async () => {
      const supabase = createServiceClient({ system: 'inngest:metrics-snapshot' })
      const { data, error } = await supabase.rpc('metrics_work_order_backlog')
      if (error) throw new Error(`metrics_work_order_backlog failed: ${error.message}`)

      const rows = (data ?? []) as Array<{ status: string; count: number }>
      const counts = new Map<string, number>(rows.map((row) => [row.status, Number(row.count)]))
      for (const status of OPEN_WO_STATUSES) {
        await recordGauge('fieldstay_work_orders_backlog', counts.get(status) ?? 0, { status })
      }
    })

    await step.run('inventory-below-par', async () => {
      const supabase = createServiceClient({ system: 'inngest:metrics-snapshot' })
      // Items never counted default current_quantity to 0, which would
      // otherwise look "below par" on every freshly-added item — the RPC
      // applies the same first_count_recorded_at exclusion
      // build-shopping-cart.ts uses before auto-cart building.
      const { data, error } = await supabase.rpc('metrics_inventory_below_par_count')
      if (error) throw new Error(`metrics_inventory_below_par_count failed: ${error.message}`)

      await recordGauge('fieldstay_inventory_below_par_count', Number((data ?? 0) as number))
    })

    await step.run('vendor-compliance-status', async () => {
      const supabase = createServiceClient({ system: 'inngest:metrics-snapshot' })
      const { data, error } = await supabase.rpc('metrics_vendor_compliance_counts')
      if (error) throw new Error(`metrics_vendor_compliance_counts failed: ${error.message}`)

      const rows = (data ?? []) as Array<{ compliance_status: string; count: number }>
      const counts = new Map<string, number>(rows.map((row) => [row.compliance_status, Number(row.count)]))
      for (const status of COMPLIANCE_STATUSES) {
        await recordGauge('fieldstay_vendor_compliance_status_count', counts.get(status) ?? 0, { status })
      }
    })

    return { ranAt: new Date().toISOString() }
  }
)
