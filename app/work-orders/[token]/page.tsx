import { createServiceClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { VendorPortal } from './vendor-portal'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'
import { unwrapJoin } from '@/lib/utils/supabase-joins'

export const metadata: Metadata = { title: 'Complete Work Order — FieldStay' }

export default async function VendorPortalPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  // Use service client — no session cookie available for vendor
  const supabase = createServiceClient()

  const { data: workOrder } = await supabase
    .from('work_orders')
    .select(`
      id, org_id, asset_id, title, description, status, portal_enabled,
      scheduled_date, estimated_cost, completion_token_expires_at,
      wo_number, category, priority, nte_amount,
      properties ( name, address, city, state, zip ),
      vendors (
        name,
        email,
        stripe_connect_token,
        stripe_connect_charges_enabled
      )
    `)
    .eq('completion_token', token)
    .eq('portal_enabled', true)
    .single()

  if (!workOrder) notFound()

  const manualUrl = await getManualUrlForAsset(
    supabase,
    workOrder.org_id,
    (workOrder as { asset_id?: string | null }).asset_id ?? null
  )

  // Check expiry
  const expired =
    workOrder.completion_token_expires_at &&
    new Date(workOrder.completion_token_expires_at) < new Date()

  const property = unwrapJoin(workOrder.properties)

  const vendor = unwrapJoin(workOrder.vendors)

  return (
    <VendorPortal
      token={token}
      workOrder={{
        id:             workOrder.id,
        title:          workOrder.title,
        description:    workOrder.description ?? null,
        status:         workOrder.status as string,
        scheduled_date: workOrder.scheduled_date ?? null,
        estimated_cost: workOrder.estimated_cost ?? null,
        wo_number:      workOrder.wo_number ?? null,
        category:       workOrder.category ?? null,
        priority:       workOrder.priority ?? null,
        nte_amount:     (workOrder as { nte_amount?: number | null }).nte_amount ?? null,
        manual_url:     manualUrl,
      }}
      property={property ?? null}
      expired={!!expired}
      vendorConnectToken={vendor?.stripe_connect_token ?? ''}
      vendorChargesEnabled={vendor?.stripe_connect_charges_enabled ?? false}
    />
  )
}
