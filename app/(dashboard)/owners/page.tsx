import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { requireOrgMember } from '@/lib/auth'
import { OwnersManager } from './owners-manager'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'

export const metadata: Metadata = { title: 'Owner Portal' }

/** Mirrors OwnersManager's `Transaction`. Nullability verified against the
 *  live schema: property_id, description and visible_to_owner are NOT NULL. */
type OwnerTransactionRow = {
  id: string; property_id: string; transaction_type: 'revenue' | 'expense'
  category: string; amount: number; description: string
  transaction_date: string; notes: string | null
  work_order_id: string | null; booking_id: string | null
  visible_to_owner: boolean; source: string | null
}

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

  // PAGINATED, not `.limit(5000)`. PostgREST's max_rows is a hard ceiling
  // applied ON TOP of the client's limit — supabase/config.toml sets it to
  // 1000 (also the Supabase cloud default), so the old `.limit(5000)` returned
  // min(5000, 1000) = 1000 rows with a 200 and no truncation signal. The
  // previous comment ("the cap sheds the oldest rows if it ever bites")
  // assumed 5000 was the real bound; it never was.
  //
  // TransactionPanel reduces this array into totalRevenue / totalExpense / net
  // and renders it as the OWNER'S P&L. Any org with more than 1000
  // owner_transactions in a rolling 13 months — trivially reached, since
  // booking_revenue, cleaning_fee, wo_completion and inventory_purchase all
  // auto-post — had every property's Net silently wrong and understated.
  //
  // The secondary sort on id is required by the pagination: transaction_date
  // is a date, so ties are common, and range() over a non-unique sort key can
  // skip or repeat rows across page boundaries.
  const transactions = await fetchAllRows<OwnerTransactionRow>(
    (from, to) => supabase
      .from('owner_transactions')
      .select('id, property_id, transaction_type, category, amount, description, transaction_date, notes, work_order_id, booking_id, visible_to_owner, source')
      .eq('org_id', membership.org_id)
      .gte('transaction_date', thirteenMonthsAgo.toISOString().split('T')[0]!)
      .order('transaction_date', { ascending: false })
      .order('id')
      .range(from, to),
    { label: 'page.owners.transactions' },
  )


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
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
