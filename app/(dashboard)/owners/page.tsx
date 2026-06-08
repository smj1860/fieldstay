import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { requireOrgMember } from '@/lib/auth'
import { OwnersManager } from './owners-manager'

export const metadata: Metadata = { title: 'Owner Portal' }

export default async function OwnersPage() {
  const { supabase, membership } = await requireOrgMember()

  // Fetch owners with property name + portal tokens
  const { data: owners } = await supabase
    .from('property_owners')
    .select(`
      id,
      name,
      email,
      phone,
      revenue_share_pct,
      notes,
      property_id,
      properties ( name ),
      owner_portal_tokens (
        id,
        token,
        expires_at,
        last_accessed_at,
        is_multi,
        property_ids
      )
    `)
    .eq('org_id', membership.org_id)
    .order('name')

  // Fetch properties for the add-owner form
  const { data: properties } = await supabase
    .from('properties')
    .select('id, name')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  // Fetch transactions for the P&L panels
  const { data: transactions } = await supabase
    .from('owner_transactions')
    .select('id, property_id, transaction_type, category, amount, description, transaction_date, notes, work_order_id, booking_id, visible_to_owner, source')
    .eq('org_id', membership.org_id)
    .order('transaction_date', { ascending: false })

  // Derive base URL for portal links
  const headersList = await headers()
  const host        = headersList.get('host') ?? 'localhost:3000'
  const protocol    = host.startsWith('localhost') ? 'http' : 'https'
  const baseUrl     = `${protocol}://${host}`

  return (
    <OwnersManager
      owners={owners ?? []}
      properties={properties ?? []}
      transactions={transactions ?? []}
      baseUrl={baseUrl}
    />
  )
}
