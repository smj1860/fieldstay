import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { VendorsClient } from './vendors-client'
import type { Vendor } from '@/types/database'

export const metadata: Metadata = { title: 'Vendors' }

export default async function VendorsPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: vendors } = await supabase
    .from('vendors')
    .select('id, name, contact_name, email, phone, specialty, portal_enabled, is_active, notes, work_orders(vendor_rating)')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('specialty')
    .order('name')

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
      <VendorsClient vendors={(vendors ?? []) as unknown as Vendor[]} showComplianceNudge={showComplianceNudge} />
    </div>
  )
}
