import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Owner Portal — FieldStay' }

interface Props {
  params: { token: string }
}

export default async function OwnerPortalPage({ params }: Props) {
  const supabase = createServiceClient()

  // Validate the token
  const { data: portalToken } = await supabase
    .from('owner_portal_tokens')
    .select(`
      id,
      expires_at,
      property_owners (
        id,
        name,
        property_id,
        revenue_share_pct,
        properties (
          id,
          name,
          address,
          city,
          state
        )
      )
    `)
    .eq('token', params.token)
    .single()

  if (!portalToken) notFound()

  // Check expiry
  if (portalToken.expires_at && new Date(portalToken.expires_at) < new Date()) {
    return (
      <div className="min-h-screen bg-accent-50 flex items-center justify-center p-4">
        <div className="card text-center max-w-sm">
          <h2 className="text-lg font-semibold text-accent-900 mb-2">Link Expired</h2>
          <p className="text-sm text-accent-500">
            This owner portal link has expired. Please contact your property manager for a new link.
          </p>
        </div>
      </div>
    )
  }

  // Record access
  await supabase
    .from('owner_portal_tokens')
    .update({ last_accessed_at: new Date().toISOString() })
    .eq('id', portalToken.id)

  const owner    = Array.isArray(portalToken.property_owners)
    ? portalToken.property_owners[0]
    : portalToken.property_owners

  const property = Array.isArray(owner?.properties)
    ? owner?.properties[0]
    : owner?.properties

  return (
    <div className="min-h-screen bg-accent-50">
      <header className="bg-brand-800 text-white px-6 py-5">
        <h1 className="text-xl font-bold">FieldStay Owner Portal</h1>
        <p className="text-brand-200 text-sm mt-0.5">
          {property?.name} — {owner?.name}
        </p>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* TODO: P&L summary, work orders, purchase orders for this property */}
        <p className="text-accent-500 text-sm">
          Owner portal for {property?.name} loading…
        </p>
      </div>
    </div>
  )
}
