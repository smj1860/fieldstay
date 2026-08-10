import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { unwrapList, unwrapCount } from '@/lib/supabase/unwrap'
import { VendorsClient } from './vendors-client'
import type { Vendor } from '@/types/database'

export const metadata: Metadata = { title: 'Vendors' }

/**
 * Trailing-12-month work orders pulled to compute vendor scorecards in memory.
 *
 * Named rather than inline so the ORDER BY beside it reads as deliberate: this
 * is a truncation point, and a truncation point without a stable sort returns
 * a different arbitrary subset on every load.
 */
const SCORECARD_WO_LIMIT = 5_000

export default async function VendorsPage() {
  const { supabase, membership } = await requireOrgMember()
  const ctx = { site: 'page.vendors', orgId: membership.org_id }

  const rawVendorsRes = await supabase
    .from('vendors')
    .select('id, name, contact_name, email, phone, specialty, portal_enabled, is_active, notes')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('specialty')
    .order('name')
    .limit(500)
  const rawVendors = unwrapList(rawVendorsRes, ctx)

  // Scorecard inputs, bounded to the trailing 12 months. The previous shape
  // embedded work_orders(...) directly on the vendors query with no bound —
  // a long-lived vendor dragged its entire work-order history into every
  // render of this page just to compute an average. A trailing-year window
  // is also a better scorecard: it reflects current performance, not 2019's.
  const oneYearAgo = new Date()
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)

  const scorecardWOsRes = await supabase
    .from('work_orders')
    .select('vendor_id, vendor_rating, scheduled_date, completed_date, status')
    .eq('org_id', membership.org_id)
    .not('vendor_id', 'is', null)
    .gte('created_at', oneYearAgo.toISOString())
    // ORDERED, so the cap below is deterministic. Without an ORDER BY, Postgres
    // is free to return any 5,000 of the matching rows, and it need not return
    // the same 5,000 twice — so an org past the cap got a scorecard that was
    // silently wrong AND silently different on every page load, with no signal
    // that anything had been dropped. Newest-first at least makes the truncated
    // window "the most recent 5,000 work orders", which is a defensible
    // statement about what the ratings and on-time percentages describe.
    .order('created_at', { ascending: false })
    .limit(SCORECARD_WO_LIMIT)
  const scorecardWOs = unwrapList(scorecardWOsRes, ctx)

  // NO SILENT CAPS. The ordering above makes a truncated window deterministic
  // and describable; it does not make it CORRECT. Past the cap, every rating
  // average and on-time percentage on this page is computed from a subset,
  // and until now nothing said so — to the PM reading it, or to us.
  //
  // A full page is the signal. It is also the trigger for replacing this
  // client-side aggregation with a server-side one; see FUTURE_REMEDIATION
  // entry 28, which records the CORRECT semantics to implement, because the
  // audit's proposed SQL does not match this page (it aggregates on a
  // `due_date` column work_orders does not have, ignores the completed-only
  // filter, and drops the >= 3 minimum sample size).
  const scorecardTruncated = scorecardWOs.length === SCORECARD_WO_LIMIT
  if (scorecardTruncated) {
    console.warn(
      `[page.vendors] org ${membership.org_id} exceeded the ${SCORECARD_WO_LIMIT}-work-order ` +
      'scorecard window — ratings and on-time percentages are computed from the most recent ' +
      'slice only. Time to move this aggregation server-side (FUTURE_REMEDIATION 28).'
    )
  }

  type ScorecardWO = {
    vendor_id: string | null
    vendor_rating: number | null
    scheduled_date: string | null
    completed_date: string | null
    status: string
  }
  const wosByVendor = new Map<string, ScorecardWO[]>()
  for (const wo of (scorecardWOs ?? []) as ScorecardWO[]) {
    if (!wo.vendor_id) continue
    const list = wosByVendor.get(wo.vendor_id) ?? []
    list.push(wo)
    wosByVendor.set(wo.vendor_id, list)
  }

  const vendors = (rawVendors ?? []).map((v) => {
    const workOrders = wosByVendor.get(v.id) ?? []

    const ratings = workOrders
      .map((wo) => wo.vendor_rating)
      .filter((r): r is number => r !== null && r > 0)

    const completedWithDates = workOrders.filter(
      (wo) => wo.status === 'completed' && wo.scheduled_date && wo.completed_date
    )
    const onTimeCount = completedWithDates.filter(
      (wo) => wo.completed_date! <= wo.scheduled_date!
    ).length

    return {
      ...v,
      avg_rating:          ratings.length > 0
        ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
        : null,
      rating_count:        ratings.length,
      on_time_pct:         completedWithDates.length >= 3
        ? Math.round((onTimeCount / completedWithDates.length) * 100)
        : null,
      on_time_sample_size: completedWithDates.length,
    }
  })

  const complianceDocCountRes = await supabase
    .from('vendor_compliance_documents')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', membership.org_id)
  const complianceDocCount = unwrapCount(complianceDocCountRes, ctx)

  const showComplianceNudge = complianceDocCount === 0

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Vendors</h1>
        <p className="page-subtitle">Manage your service vendors and contractor contacts</p>
        {scorecardTruncated && (
          <p className="text-xs mt-2" style={{ color: 'var(--accent-amber)' }}>
            Scorecards reflect your most recent {SCORECARD_WO_LIMIT.toLocaleString()} work
            orders from the past year, not the full history.
          </p>
        )}
      </div>
      <VendorsClient vendors={vendors as unknown as Vendor[]} showComplianceNudge={showComplianceNudge} />
    </div>
  )
}
