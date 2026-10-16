// The owner's read-only copy of a work order's sealed before and after photos,
// reached from the "View photos" link on a transaction in their statement.
//
// TOKEN-GATED, no session. Three checks, and the third is the point:
//   1. the token is valid (not revoked, not expired);
//   2. the work order's property is one of the properties THIS token authorizes
//      (an org holds every owner's properties; an org-scoped lookup by work
//      order id would hand one owner another owner's photographs);
//   3. a transaction on that work order is VISIBLE TO THE OWNER. A work order
//      the PM chose not to show on the statement does not get a photo page by
//      guessing its id.
// Every rejection is the same 404: distinguishing them turns a guessable id
// into an oracle. Throttled by proxy.ts (TOKEN_ROUTES '/owner/').
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { isUuid } from '@/lib/validation/uuid'
import { validatePortalToken, resolvePortalScope, authorizesProperty } from '@/lib/owner-portal/token'
import { loadWorkOrderEvidence } from '@/lib/evidence/work-order-evidence'
import { WorkOrderPhotoGallery } from '@/components/evidence/WorkOrderPhotoGallery'

export const metadata: Metadata = { title: 'Work Order Photos | FieldStay' }

interface Props { params: Promise<{ token: string; workOrderId: string }> }

export default async function OwnerWorkOrderPhotosPage({ params }: Readonly<Props>) {
  const { token, workOrderId } = await params
  if (!isUuid(workOrderId)) notFound()

  const supabase = createServiceClient({ publicSurface: 'owner-portal' })
  const validated = await validatePortalToken(supabase, token)
  if (!validated.ok) notFound()
  const scope = await resolvePortalScope(supabase, validated.token)
  if (!scope) notFound()

  const woRes = await supabase
    .from('work_orders').select('id, property_id, title')
    .eq('id', workOrderId).eq('org_id', scope.orgId).maybeSingle()
  const wo = unwrap(woRes, { site: 'page.owner.workOrderPhotos.workOrder', orgId: scope.orgId })
  if (!wo || !authorizesProperty(scope, wo.property_id)) notFound()

  const visibleRes = await supabase
    .from('owner_transactions').select('id')
    .eq('org_id', scope.orgId).eq('work_order_id', workOrderId).eq('property_id', wo.property_id)
    .eq('visible_to_owner', true).limit(1)
  const visible = unwrap(visibleRes, { site: 'page.owner.workOrderPhotos.visible', orgId: scope.orgId })
  if (!visible || visible.length === 0) notFound()

  const evidence = await loadWorkOrderEvidence(supabase, {
    orgId: scope.orgId, workOrderId, sides: ['before', 'after'],
  })

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <Link href={`/owner/${token}`} className="text-sm text-muted-themed hover:text-secondary-themed">Back to statement</Link>
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{wo.title}</h1>
      <WorkOrderPhotoGallery evidence={evidence} />
    </div>
  )
}
