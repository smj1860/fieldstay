// Sealed before and after photographs for one work order: the target of the
// "View photos" link on the owner P&L (app/(dashboard)/owners).
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { isUuid } from '@/lib/validation/uuid'
import { loadWorkOrderEvidence } from '@/lib/evidence/work-order-evidence'
import { WorkOrderPhotoGallery } from '@/components/evidence/WorkOrderPhotoGallery'

export const metadata: Metadata = { title: 'Work Order Photos' }

interface Props { params: Promise<{ id: string }> }

export default async function WorkOrderEvidencePage({ params }: Readonly<Props>) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const { supabase, membership } = await requireOrgMember()
  const orgId = membership.org_id

  // IDOR: the work order must belong to the caller's org before anything is signed.
  const woRes = await supabase
    .from('work_orders').select('id, title, wo_number')
    .eq('id', id).eq('org_id', orgId).maybeSingle()
  const wo = unwrap(woRes, { site: 'page.maintenance.evidence.workOrder', orgId })
  if (!wo) notFound()

  const service = createServiceClient({ authorizedBy: membership })
  const evidence = await loadWorkOrderEvidence(service, { orgId, workOrderId: id, sides: ['before', 'after'] })

  return (
    <div className="max-w-4xl space-y-4">
      <Link href={`/maintenance/${id}`} className="text-sm inline-flex items-center gap-1 text-muted-themed hover:text-secondary-themed">
        <ChevronLeft className="w-4 h-4" /> Work order
      </Link>
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
        {wo.wo_number ? `${wo.wo_number}: ` : ''}{wo.title}
      </h1>
      <WorkOrderPhotoGallery evidence={evidence} />
    </div>
  )
}
