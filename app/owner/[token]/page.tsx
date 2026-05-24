import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import type { Metadata } from 'next'
import type { TxnType, TxnCategory } from '@/types/database'
import { formatDate } from '@/lib/utils'

export const metadata: Metadata = { title: 'Owner Portal — FieldStay' }

interface Props {
  params: Promise<{ token: string }>
}

const CATEGORY_LABELS: Record<TxnCategory, string> = {
  booking_revenue: 'Booking Revenue',
  cleaning_fee:    'Cleaning Fee',
  maintenance:     'Maintenance',
  restock:         'Restock',
  utility:         'Utility',
  insurance:       'Insurance',
  supplies:        'Supplies',
  other:           'Other',
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount)
}

function getMonthKey(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
}

export default async function OwnerPortalPage({ params }: Props) {
  const { token } = await params
  const supabase = createServiceClient()

  // Validate the token + fetch owner + property in one query
  const { data: portalToken } = await supabase
    .from('owner_portal_tokens')
    .select(`
      id,
      expires_at,
      last_accessed_at,
      property_owners (
        id,
        name,
        revenue_share_pct,
        property_id,
        properties (
          id,
          name,
          address,
          city,
          state,
          zip
        )
      )
    `)
    .eq('token', token)
    .single()

  if (!portalToken) notFound()

  // Check expiry
  if (portalToken.expires_at && new Date(portalToken.expires_at) < new Date()) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center max-w-sm w-full">
          <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Link Expired</h2>
          <p className="text-sm text-gray-500">
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

  const owner = Array.isArray(portalToken.property_owners)
    ? portalToken.property_owners[0]
    : portalToken.property_owners

  if (!owner) notFound()

  const property = Array.isArray(owner.properties)
    ? owner.properties[0]
    : owner.properties

  if (!property) notFound()

  // Fetch transactions for this property
  const { data: transactions } = await supabase
    .from('owner_transactions')
    .select('id, transaction_type, category, amount, description, transaction_date, notes')
    .eq('property_id', owner.property_id)
    .order('transaction_date', { ascending: false })

  const txns = transactions ?? []

  // Compute summary
  const totalRevenue  = txns
    .filter((t) => t.transaction_type === 'revenue')
    .reduce((sum, t) => sum + t.amount, 0)
  const totalExpenses = txns
    .filter((t) => t.transaction_type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0)
  const netIncome = totalRevenue - totalExpenses

  // Group by month
  const byMonth = txns.reduce<Record<string, typeof txns>>((acc, t) => {
    const key = getMonthKey(t.transaction_date)
    if (!acc[key]) acc[key] = []
    acc[key].push(t)
    return acc
  }, {})

  const monthKeys = Object.keys(byMonth) // already sorted desc from DB

  // Address display
  const addressParts = [
    property.address,
    property.city,
    property.state,
    property.zip,
  ].filter(Boolean)
  const addressDisplay = addressParts.length > 0 ? addressParts.join(', ') : null

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-5 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">
                FieldStay Owner Portal
              </p>
              <h1 className="text-2xl font-bold text-gray-900">{property.name}</h1>
              {addressDisplay && (
                <p className="text-sm text-gray-500 mt-0.5">{addressDisplay}</p>
              )}
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-sm font-medium text-gray-700">{owner.name}</p>
              {owner.revenue_share_pct != null && (
                <p className="text-xs text-gray-400 mt-0.5">{owner.revenue_share_pct}% revenue share</p>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-8 sm:px-6">

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {/* Revenue */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
              Total Revenue
            </p>
            <p className="text-2xl font-bold text-green-600">{formatCurrency(totalRevenue)}</p>
          </div>

          {/* Expenses */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
              Total Expenses
            </p>
            <p className="text-2xl font-bold text-red-600">{formatCurrency(totalExpenses)}</p>
          </div>

          {/* Net income */}
          <div className={`rounded-xl border p-5 ${
            netIncome >= 0
              ? 'bg-green-50 border-green-200'
              : 'bg-red-50 border-red-200'
          }`}>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
              Net Income
            </p>
            <p className={`text-2xl font-bold ${
              netIncome >= 0 ? 'text-green-700' : 'text-red-700'
            }`}>
              {formatCurrency(netIncome)}
            </p>
          </div>
        </div>

        {/* Transactions */}
        {txns.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <p className="text-gray-400 text-sm">No transactions recorded yet.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {monthKeys.map((month) => {
              const monthTxns = byMonth[month]
              const monthRevenue  = monthTxns.filter((t) => t.transaction_type === 'revenue').reduce((s, t) => s + t.amount, 0)
              const monthExpenses = monthTxns.filter((t) => t.transaction_type === 'expense').reduce((s, t) => s + t.amount, 0)
              const monthNet = monthRevenue - monthExpenses

              return (
                <div key={month} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  {/* Month header */}
                  <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">
                    <h2 className="font-semibold text-gray-700 text-sm">{month}</h2>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="text-green-600 font-medium">+{formatCurrency(monthRevenue)}</span>
                      <span className="text-red-600 font-medium">−{formatCurrency(monthExpenses)}</span>
                      <span className={`font-semibold ${monthNet >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                        = {formatCurrency(monthNet)}
                      </span>
                    </div>
                  </div>

                  {/* Transactions for this month */}
                  <div className="divide-y divide-gray-100">
                    {monthTxns.map((txn) => {
                      const isRevenue = txn.transaction_type === 'revenue'
                      return (
                        <div key={txn.id} className="flex items-center gap-4 px-5 py-3">
                          <div className="w-20 flex-shrink-0 text-xs text-gray-400">
                            {formatDate(txn.transaction_date)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{txn.description}</p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {CATEGORY_LABELS[txn.category as TxnCategory] ?? txn.category}
                              {txn.notes ? ` · ${txn.notes}` : ''}
                            </p>
                          </div>
                          <div className={`text-sm font-semibold flex-shrink-0 ${
                            isRevenue ? 'text-green-600' : 'text-red-600'
                          }`}>
                            {isRevenue ? '+' : '−'}{formatCurrency(txn.amount)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <p className="text-center text-xs text-gray-400 mt-8">
          Powered by FieldStay · Data is read-only
        </p>
      </div>
    </div>
  )
}
