'use client'

import { useState, useTransition, useActionState } from 'react'
import { Plus, X, Link2, RefreshCw, Copy, Check, ExternalLink, ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  addPropertyOwner,
  generatePortalToken,
  addOwnerTransaction,
  deleteOwnerTransaction,
  type OwnersActionState,
} from './actions'

interface Property {
  id: string
  name: string
}

interface PortalToken {
  id: string
  token: string
  expires_at: string | null
  last_accessed_at: string | null
}

interface Owner {
  id: string
  name: string
  email: string | null
  phone: string | null
  revenue_share_pct: number | null
  notes: string | null
  property_id: string
  properties: { name: string } | { name: string }[] | null
  owner_portal_tokens: PortalToken | PortalToken[] | null
}

interface Transaction {
  id: string
  property_id: string
  transaction_type: 'revenue' | 'expense'
  category: string
  amount: number
  description: string
  transaction_date: string
  notes: string | null
  work_order_id: string | null
  booking_id: string | null
}

const REVENUE_CATEGORIES = [
  { value: 'booking_revenue', label: 'Booking Revenue' },
  { value: 'other',           label: 'Other Revenue' },
]

const EXPENSE_CATEGORIES = [
  { value: 'cleaning_fee', label: 'Cleaning Fee' },
  { value: 'maintenance',  label: 'Maintenance' },
  { value: 'restock',      label: 'Restock / Supplies' },
  { value: 'utility',      label: 'Utility' },
  { value: 'insurance',    label: 'Insurance' },
  { value: 'supplies',     label: 'Supplies' },
  { value: 'other',        label: 'Other' },
]

const CATEGORY_LABELS: Record<string, string> = {
  booking_revenue: 'Booking Revenue',
  cleaning_fee:    'Cleaning Fee',
  maintenance:     'Maintenance',
  restock:         'Restock',
  utility:         'Utility',
  insurance:       'Insurance',
  supplies:        'Supplies',
  other:           'Other',
}

function getPropertyName(owner: Owner): string {
  const p = Array.isArray(owner.properties) ? owner.properties[0] : owner.properties
  return p?.name ?? '—'
}

function getToken(owner: Owner): PortalToken | null {
  const t = Array.isArray(owner.owner_portal_tokens)
    ? owner.owner_portal_tokens[0]
    : owner.owner_portal_tokens
  return t ?? null
}

function isTokenExpired(token: PortalToken): boolean {
  if (!token.expires_at) return false
  return new Date(token.expires_at) < new Date()
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

function todayIso() {
  return new Date().toISOString().split('T')[0]
}

// ── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="btn-ghost py-1 px-2 text-xs flex items-center gap-1"
      title="Copy portal link"
    >
      {copied ? (
        <><Check className="w-3.5 h-3.5 text-green-600" /> Copied</>
      ) : (
        <><Copy className="w-3.5 h-3.5" /> Copy Link</>
      )}
    </button>
  )
}

// ── Generate Link Button ─────────────────────────────────────────────────────

function GenerateLinkButton({ ownerId }: { ownerId: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const handleGenerate = () => {
    setError(null)
    startTransition(async () => {
      const result = await generatePortalToken(ownerId)
      if (result.error) setError(result.error)
    })
  }

  return (
    <div>
      <button
        onClick={handleGenerate}
        disabled={pending}
        className="btn-secondary py-1 px-2 text-xs flex items-center gap-1 disabled:opacity-50"
      >
        <RefreshCw className={cn('w-3.5 h-3.5', pending && 'animate-spin')} />
        {pending ? 'Generating…' : 'Generate Link'}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  )
}

// ── Add Transaction Form ─────────────────────────────────────────────────────

function AddTransactionForm({
  propertyId,
  onClose,
}: {
  propertyId: string
  onClose: () => void
}) {
  const [state, formAction, pending] = useActionState(addOwnerTransaction, null)
  const [txnType, setTxnType] = useState<'revenue' | 'expense'>('revenue')

  if (state?.success) {
    onClose()
    return null
  }

  const categories = txnType === 'revenue' ? REVENUE_CATEGORIES : EXPENSE_CATEGORIES

  return (
    <div className="mt-3 border border-accent-200 rounded-xl p-4 bg-accent-50">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-accent-800">Add Transaction</h4>
        <button onClick={onClose} className="btn-ghost p-1">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {state?.error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-3">
        <input type="hidden" name="property_id" value={propertyId} />
        <input type="hidden" name="transaction_type" value={txnType} />

        {/* Type toggle */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTxnType('revenue')}
            className={cn(
              'flex-1 py-1.5 text-sm rounded-lg font-medium border transition-colors',
              txnType === 'revenue'
                ? 'bg-green-600 text-white border-green-600'
                : 'bg-white text-accent-600 border-accent-200 hover:border-accent-400'
            )}
          >
            + Revenue
          </button>
          <button
            type="button"
            onClick={() => setTxnType('expense')}
            className={cn(
              'flex-1 py-1.5 text-sm rounded-lg font-medium border transition-colors',
              txnType === 'expense'
                ? 'bg-red-600 text-white border-red-600'
                : 'bg-white text-accent-600 border-accent-200 hover:border-accent-400'
            )}
          >
            − Expense
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label text-xs">Date</label>
            <input
              name="transaction_date"
              type="date"
              required
              defaultValue={todayIso()}
              className="input text-sm"
            />
          </div>
          <div>
            <label className="label text-xs">Category</label>
            <select name="category" required className="input text-sm">
              {categories.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label text-xs">Description <span className="text-red-500">*</span></label>
          <input name="description" type="text" required className="input text-sm" placeholder="e.g. 4-night stay, HVAC repair" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label text-xs">Amount ($) <span className="text-red-500">*</span></label>
            <input name="amount" type="number" required min="0.01" step="0.01" className="input text-sm" placeholder="0.00" />
          </div>
          <div>
            <label className="label text-xs">Notes</label>
            <input name="notes" type="text" className="input text-sm" placeholder="Optional" />
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={pending} className="btn-primary py-1.5 text-sm flex-1">
            {pending ? 'Saving…' : 'Add Transaction'}
          </button>
          <button type="button" onClick={onClose} className="btn-ghost py-1.5 text-sm">
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

// ── Transaction Panel ────────────────────────────────────────────────────────

function TransactionPanel({
  propertyId,
  transactions,
}: {
  propertyId: string
  transactions: Transaction[]
}) {
  const [expanded, setExpanded]       = useState(false)
  const [showForm, setShowForm]       = useState(false)
  const [deletingId, setDeletingId]   = useState<string | null>(null)
  const [, startTransition]           = useTransition()

  const propertyTxns = transactions.filter((t) => t.property_id === propertyId)
  const totalRevenue = propertyTxns.filter((t) => t.transaction_type === 'revenue').reduce((s, t) => s + t.amount, 0)
  const totalExpense = propertyTxns.filter((t) => t.transaction_type === 'expense').reduce((s, t) => s + t.amount, 0)
  const net          = totalRevenue - totalExpense

  const handleDelete = (id: string) => {
    setDeletingId(id)
    startTransition(async () => {
      await deleteOwnerTransaction(id)
      setDeletingId(null)
    })
  }

  return (
    <div className="mt-3 border-t border-accent-100 pt-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm font-medium text-accent-700 hover:text-accent-900 w-full text-left"
      >
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        Transactions
        <span className="ml-auto text-xs text-accent-400">{propertyTxns.length} entries</span>
        <span className={cn('text-xs font-semibold', net >= 0 ? 'text-green-600' : 'text-red-600')}>
          Net {formatCurrency(net)}
        </span>
      </button>

      {expanded && (
        <div className="mt-3">
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div className="bg-green-50 rounded-lg p-2 text-center">
              <div className="text-xs text-green-600 mb-0.5">Revenue</div>
              <div className="text-sm font-semibold text-green-700">{formatCurrency(totalRevenue)}</div>
            </div>
            <div className="bg-red-50 rounded-lg p-2 text-center">
              <div className="text-xs text-red-600 mb-0.5">Expenses</div>
              <div className="text-sm font-semibold text-red-700">{formatCurrency(totalExpense)}</div>
            </div>
            <div className={cn('rounded-lg p-2 text-center', net >= 0 ? 'bg-accent-50' : 'bg-amber-50')}>
              <div className="text-xs text-accent-500 mb-0.5">Net</div>
              <div className={cn('text-sm font-semibold', net >= 0 ? 'text-accent-800' : 'text-amber-700')}>
                {formatCurrency(net)}
              </div>
            </div>
          </div>

          {/* Transaction list */}
          {propertyTxns.length > 0 ? (
            <div className="border border-accent-100 rounded-xl overflow-hidden mb-3">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-accent-50 border-b border-accent-100">
                    <th className="text-left px-3 py-2 text-accent-500 font-medium">Date</th>
                    <th className="text-left px-3 py-2 text-accent-500 font-medium">Description</th>
                    <th className="text-left px-3 py-2 text-accent-500 font-medium">Category</th>
                    <th className="text-right px-3 py-2 text-accent-500 font-medium">Amount</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {propertyTxns.map((txn) => (
                    <tr key={txn.id} className="border-b border-accent-50 last:border-0">
                      <td className="px-3 py-2 text-accent-500 whitespace-nowrap">
                        {new Date(txn.transaction_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                      </td>
                      <td className="px-3 py-2 text-accent-700 max-w-[160px]">
                        <div className="truncate">{txn.description}</div>
                        {txn.notes && <div className="truncate text-accent-400">{txn.notes}</div>}
                      </td>
                      <td className="px-3 py-2 text-accent-500 whitespace-nowrap">
                        {CATEGORY_LABELS[txn.category] ?? txn.category}
                      </td>
                      <td className={cn(
                        'px-3 py-2 text-right font-medium whitespace-nowrap',
                        txn.transaction_type === 'revenue' ? 'text-green-600' : 'text-red-600'
                      )}>
                        {txn.transaction_type === 'revenue' ? '+' : '−'}{formatCurrency(txn.amount)}
                      </td>
                      <td className="px-2 py-2">
                        {!txn.work_order_id && !txn.booking_id && (
                          <button
                            onClick={() => handleDelete(txn.id)}
                            disabled={deletingId === txn.id}
                            className="btn-ghost p-1 text-accent-400 hover:text-red-600"
                            title="Delete transaction"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-accent-400 mb-3">No transactions yet.</p>
          )}

          {/* Add form or button */}
          {showForm ? (
            <AddTransactionForm propertyId={propertyId} onClose={() => setShowForm(false)} />
          ) : (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="btn-ghost text-xs flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Transaction
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Add Owner Modal ──────────────────────────────────────────────────────────

function AddOwnerModal({
  properties,
  onClose,
}: {
  properties: Property[]
  onClose: () => void
}) {
  const [state, formAction, pending] = useActionState(addPropertyOwner, null)

  if (state?.success) {
    onClose()
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-card-lg w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-accent-900">Add Property Owner</h3>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {state?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="property_id" className="label">
              Property <span className="text-red-500">*</span>
            </label>
            <select id="property_id" name="property_id" required className="input">
              <option value="">Select property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="name" className="label">
              Owner Name <span className="text-red-500">*</span>
            </label>
            <input id="name" name="name" type="text" required className="input" placeholder="Jane Smith" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input id="email" name="email" type="email" className="input" placeholder="jane@example.com" />
            </div>
            <div>
              <label htmlFor="phone" className="label">Phone</label>
              <input id="phone" name="phone" type="tel" className="input" placeholder="(555) 123-4567" />
            </div>
          </div>

          <div>
            <label htmlFor="revenue_share_pct" className="label">Revenue Share %</label>
            <input id="revenue_share_pct" name="revenue_share_pct" type="number" min="0" max="100" step="0.1" className="input" placeholder="e.g. 80" />
          </div>

          <div>
            <label htmlFor="notes" className="label">Notes</label>
            <textarea id="notes" name="notes" rows={2} className="input resize-none" placeholder="Any additional notes…" />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={pending} className="btn-primary flex-1">
              {pending ? 'Saving…' : 'Add Owner'}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Owner Card ───────────────────────────────────────────────────────────────

function OwnerCard({
  owner,
  baseUrl,
  transactions,
}: {
  owner: Owner
  baseUrl: string
  transactions: Transaction[]
}) {
  const token     = getToken(owner)
  const expired   = token ? isTokenExpired(token) : false
  const portalUrl = token && !expired ? `${baseUrl}/owner/${token.token}` : null

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="font-semibold text-accent-900">{owner.name}</div>
          <div className="text-sm text-accent-500 mt-0.5">{getPropertyName(owner)}</div>
          {owner.email && <div className="text-xs text-accent-400 mt-0.5">{owner.email}</div>}
          {owner.revenue_share_pct != null && (
            <div className="text-xs text-accent-400">{owner.revenue_share_pct}% revenue share</div>
          )}
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {portalUrl ? (
            <>
              <span className="badge badge-green text-xs flex items-center gap-1">
                <Link2 className="w-3 h-3" /> Active Link
              </span>
              <CopyButton text={portalUrl} />
              <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost py-1 px-2 text-xs flex items-center gap-1">
                <ExternalLink className="w-3.5 h-3.5" /> View
              </a>
              <GenerateLinkButton ownerId={owner.id} />
            </>
          ) : (
            <>
              {token && expired && <span className="badge badge-amber text-xs">Expired</span>}
              {!token && <span className="badge badge-slate text-xs">No link</span>}
              <GenerateLinkButton ownerId={owner.id} />
            </>
          )}
        </div>
      </div>

      <TransactionPanel propertyId={owner.property_id} transactions={transactions} />
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export function OwnersManager({
  owners,
  properties,
  transactions,
  baseUrl,
}: {
  owners: Owner[]
  properties: Property[]
  transactions: Transaction[]
  baseUrl: string
}) {
  const [showAdd, setShowAdd] = useState(false)

  return (
    <>
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Owner Portal</h1>
          <p className="page-subtitle">
            Manage property owners and track P&L for each property
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary">
          <Plus className="w-4 h-4" />
          Add Owner
        </button>
      </div>

      {owners.length === 0 ? (
        <div className="card text-center py-16 max-w-md mx-auto">
          <Link2 className="w-10 h-10 text-accent-300 mx-auto mb-3" />
          <h3 className="font-semibold text-accent-700 mb-1">No owners yet</h3>
          <p className="text-sm text-accent-400 mb-4">
            Add property owners to give them access to their P&L via a secure portal link.
          </p>
          <button onClick={() => setShowAdd(true)} className="btn-primary mx-auto">
            <Plus className="w-4 h-4" />
            Add First Owner
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {owners.map((owner) => (
            <OwnerCard
              key={owner.id}
              owner={owner}
              baseUrl={baseUrl}
              transactions={transactions}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <AddOwnerModal properties={properties} onClose={() => setShowAdd(false)} />
      )}
    </>
  )
}
