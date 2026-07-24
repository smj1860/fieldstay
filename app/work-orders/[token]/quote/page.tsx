import { createServiceClient } from '@/lib/supabase/server'
import { VendorQuotePortal }   from '../vendor-portal'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'

interface Props { params: Promise<{ token: string }> }

export default async function QuotePortalPage({ params }: Props) {
  const { token }  = await params
  const supabase   = createServiceClient({ publicSurface: 'work-orders--token--quote' })

  const { data: qr } = await supabase
    .from('quote_requests')
    .select(`
      id, status, quote_token_expires_at,
      work_orders (
        id, title, description, scheduled_date, estimated_cost,
        wo_number, category, priority, nte_amount,
        properties (name, address, city, state, zip)
      )
    `)
    .eq('quote_token', token)
    .single()

  if (!qr) {
    return (
      <div className="min-h-screen bg-accent-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow p-8 max-w-md w-full text-center">
          <h2 className="text-xl font-semibold text-accent-900 mb-2">Not Found</h2>
          <p className="text-sm text-accent-500">This quote link is invalid or has been removed.</p>
        </div>
      </div>
    )
  }

  const wo       = unwrapJoin(qr.work_orders)
  const property = wo && unwrapJoin(wo.properties)
  const expired  = new Date(qr.quote_token_expires_at) < new Date()

  return (
    <VendorQuotePortal
      token={token}
      quoteRequestStatus={qr.status}
      workOrder={{
        id:             wo?.id ?? '',
        title:          wo?.title ?? '',
        description:    wo?.description ?? null,
        scheduled_date: wo?.scheduled_date ?? null,
        estimated_cost: wo?.estimated_cost ?? null,
        wo_number:      (wo as { wo_number?: string | null } | null)?.wo_number ?? null,
        category:       (wo as { category?: string | null } | null)?.category ?? null,
        priority:       (wo as { priority?: string | null } | null)?.priority ?? null,
        nte_amount:     (wo as { nte_amount?: number | null } | null)?.nte_amount ?? null,
      }}
      property={property ?? null}
      expired={expired}
    />
  )
}
