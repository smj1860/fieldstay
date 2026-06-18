import { createServiceClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { VendorPortal } from './vendor-portal'

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
      id, title, description, status, portal_enabled,
      scheduled_date, estimated_cost, completion_token_expires_at,
      wo_number, category, priority, nte_amount,
      properties ( name, address_line1, city, state, zip )
    `)
    .eq('completion_token', token)
    .eq('portal_enabled', true)
    .single()

  if (!workOrder) notFound()

  // Check expiry
  const expired =
    workOrder.completion_token_expires_at &&
    new Date(workOrder.completion_token_expires_at) < new Date()

  const property = Array.isArray(workOrder.properties)
    ? workOrder.properties[0]
    : workOrder.properties

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
        wo_category:    workOrder.category ?? null,
        priority_level: workOrder.priority ?? null,
        nte_amount:     (workOrder as { nte_amount?: number | null }).nte_amount ?? null,
      }}
      property={property ?? null}
      expired={!!expired}
    />
  )
}
