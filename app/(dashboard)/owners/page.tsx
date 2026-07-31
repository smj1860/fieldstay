import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { requireOrgMember } from '@/lib/auth'
import { OwnersManager } from './owners-manager'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Owner Portal' }

export default async function OwnersPage() {
  const { supabase, membership } = await requireOrgMember()

  // Fetch owners with property name + portal tokens
  const { data: owners, error: ownersError } = await supabase
    .from('property_owners')
    .select(`
      id,
      name,
      email,
      phone,
      revenue_share_pct,
      notes,
      property_id,
      share_capital_plan,
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


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.owners', orgId: membership.org_id }, ownersError)
  // Fetch properties for the add-owner form
  const { data: properties, error: propertiesError } = await supabase
    .from('properties')
    .select('id, name')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.owners', orgId: membership.org_id }, propertiesError)
  // Fetch transactions for the P&L panels — bounded to a rolling 13 months
  // (matching the occupancy report's window) so this doesn't grow unboundedly
  // with org history.
  const thirteenMonthsAgo = new Date()
  thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13)

  // Hard cap on top of the window: a busy org can still put thousands of
  // rows in 13 months, and every one of them ships to the client component.
  // Newest-first means the cap sheds the oldest rows if it ever bites.
  const { data: transactions, error: transactionsError } = await supabase
    .from('owner_transactions')
    .select('id, property_id, transaction_type, category, amount, description, transaction_date, notes, work_order_id, booking_id, visible_to_owner, source')
    .eq('org_id', membership.org_id)
    .gte('transaction_date', thirteenMonthsAgo.toISOString().split('T')[0]!)
    .order('transaction_date', { ascending: false })
    .limit(5000)


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.owners', orgId: membership.org_id }, transactionsError)
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
