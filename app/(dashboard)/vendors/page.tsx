import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { VendorsClient } from './vendors-client'
import type { Vendor } from '@/types/database'

export const metadata: Metadata = { title: 'Vendors' }

export default async function VendorsPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: rawVendors } = await supabase
    .from('vendors')
    .select('id, name, contact_name, email, phone, specialty, portal_enabled, is_active, notes')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('specialty')
    .order('name')

  // Scorecard inputs, bounded to the trailing 12 months. The previous shape
  // embedded work_orders(...) directly on the vendors query with no bound —
  // a long-lived vendor dragged its entire work-order history into every
  // render of this page just to compute an average. A trailing-year window
  // is also a better scorecard: it reflects current performance, not 2019's.
  const oneYearAgo = new Date()
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)

  const { data: scorecardWOs } = await supabase
    .from('work_orders')
    .select('vendor_id, vendor_rating, scheduled_date, completed_date, status')
    .eq('org_id', membership.org_id)
    .not('vendor_id', 'is', null)
    .gte('created_at', oneYearAgo.toISOString())
    .limit(5000)

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

  const { count: complianceDocCount } = await supabase
    .from('vendor_compliance_documents')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', membership.org_id)

  const showComplianceNudge = (complianceDocCount ?? 0) === 0

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Vendors</h1>
        <p className="page-subtitle">Manage your service vendors and contractor contacts</p>
      </div>
      <VendorsClient vendors={vendors as unknown as Vendor[]} showComplianceNudge={showComplianceNudge} />
    </div>
  )
}
