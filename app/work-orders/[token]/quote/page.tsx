import { createServiceClient } from '@/lib/supabase/server'
import { VendorQuotePortal } from '../vendor-portal'

interface Props { params: Promise<{ token: string }> }

export default async function QuotePortalPage({ params }: Props) {
  const { token } = await params
  const supabase  = createServiceClient()

  const { data: workOrder } = await supabase
    .from('work_orders')
    .select(`
      id, title, description, status, scheduled_date,
      estimated_cost, quote_token_expires_at,
      properties (name, city, state)
    `)
    .eq('quote_token', token)
    .single()

  if (!workOrder) {
    return (
      <div className="min-h-screen bg-accent-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow p-8 max-w-md w-full text-center">
          <h2 className="text-xl font-semibold text-accent-900 mb-2">Not Found</h2>
          <p className="text-sm text-accent-500">This quote link is invalid or has been removed.</p>
        </div>
      </div>
    )
  }

  const property = Array.isArray(workOrder.properties)
    ? workOrder.properties[0]
    : workOrder.properties

  const expired = workOrder.quote_token_expires_at
    ? new Date(workOrder.quote_token_expires_at) < new Date()
    : false

  return (
    <VendorQuotePortal
      token={token}
      workOrder={{
        id:             workOrder.id,
        title:          workOrder.title,
        description:    workOrder.description,
        status:         workOrder.status,
        scheduled_date: workOrder.scheduled_date,
        estimated_cost: workOrder.estimated_cost,
      }}
      property={property ?? null}
      expired={expired}
    />
  )
}
