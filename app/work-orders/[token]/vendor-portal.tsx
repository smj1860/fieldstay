'use client'

import { useState } from 'react'
import { CheckCircle2, AlertTriangle, Clock, Calendar, Wrench, DollarSign } from 'lucide-react'

interface WorkOrderInfo {
  id:             string
  title:          string
  description:    string | null
  status?:        string
  scheduled_date: string | null
  estimated_cost: number | null
  wo_number:      string | null
  wo_category:    string | null
  priority_level: string | null
  nte_amount:     number | null
}

interface PropertyInfo {
  name:          string
  address_line1: string | null
  city:          string | null
  state:         string | null
  zip:           string | null
}

const CATEGORY_LABELS: Record<string, string> = {
  hvac:          'HVAC',
  plumbing:      'Plumbing',
  electrical:    'Electrical',
  appliance:     'Appliance',
  cleaning:      'Cleaning',
  landscaping:   'Landscaping',
  roofing:       'Roofing',
  flooring:      'Flooring',
  windows_doors: 'Windows & Doors',
  pest_control:  'Pest Control',
  pool:          'Pool / Spa',
  structural:    'Structural',
  general:       'General Maintenance',
  other:         'Other',
}

const PRIORITY_STYLES: Record<string, { bg: string; text: string }> = {
  low:    { bg: '#f1f5f9', text: '#64748b' },
  medium: { bg: '#dbeafe', text: '#1d4ed8' },
  high:   { bg: '#fef3c7', text: '#b45309' },
  urgent: { bg: '#fee2e2', text: '#b91c1c' },
}

// ── Shared layout wrapper ─────────────────────────────────────────────────────

function PortalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-accent-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-[0_4px_24px_0_rgba(0,0,0,.10)] w-full max-w-md p-8">
        <div className="text-center mb-6">
          <span className="text-brand-800 text-2xl font-bold tracking-tight">FieldStay</span>
          <p className="text-accent-400 text-xs mt-1">Vendor Portal</p>
        </div>
        {children}
      </div>
    </div>
  )
}

function WOInfo({ workOrder, property }: { workOrder: WorkOrderInfo; property: PropertyInfo | null }) {
  const categoryLabel  = workOrder.wo_category ? (CATEGORY_LABELS[workOrder.wo_category] ?? workOrder.wo_category) : null
  const priorityStyle  = workOrder.priority_level ? (PRIORITY_STYLES[workOrder.priority_level] ?? PRIORITY_STYLES.low) : null
  const priorityLabel  = workOrder.priority_level
    ? workOrder.priority_level.charAt(0).toUpperCase() + workOrder.priority_level.slice(1)
    : null

  const addressLine = property?.address_line1 ?? null
  const cityState   = [property?.city, property?.state].filter(Boolean).join(', ')
  const zipSuffix   = property?.zip ? ` ${property.zip}` : ''
  const fullAddress = addressLine
    ? `${addressLine}, ${cityState}${zipSuffix}`
    : cityState ? `${cityState}${zipSuffix}` : null

  return (
    <div className="rounded-xl border border-accent-200 mb-6 overflow-hidden">
      {/* Header bar */}
      <div className="bg-accent-900 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Wrench className="w-4 h-4 text-accent-400 flex-shrink-0" />
          <span className="text-white font-semibold text-sm truncate">{workOrder.title}</span>
        </div>
        {workOrder.wo_number && (
          <span className="text-xs font-bold text-accent-400 tracking-widest flex-shrink-0 uppercase">
            WO-{workOrder.wo_number}
          </span>
        )}
      </div>

      <div className="bg-white p-4 space-y-3">
        {/* Property address */}
        {property && (
          <div className="bg-accent-50 rounded-lg px-3 py-2.5 border-l-2 border-yellow-400">
            <p className="text-xs font-semibold text-accent-900">{property.name}</p>
            {fullAddress && (
              <p className="text-xs text-accent-500 mt-0.5">{fullAddress}</p>
            )}
          </div>
        )}

        {/* Category + Priority badges */}
        {(categoryLabel || priorityLabel) && (
          <div className="flex items-center gap-2 flex-wrap">
            {categoryLabel && (
              <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-accent-100 text-accent-600">
                {categoryLabel}
              </span>
            )}
            {priorityLabel && priorityStyle && (
              <span
                className="text-xs font-bold px-2.5 py-1 rounded-full"
                style={{ backgroundColor: priorityStyle.bg, color: priorityStyle.text }}
              >
                {priorityLabel}
              </span>
            )}
          </div>
        )}

        {/* Scheduled date */}
        {workOrder.scheduled_date && (
          <div className="flex items-center gap-2 text-xs text-accent-500">
            <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
              Scheduled:{' '}
              {new Date(workOrder.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              })}
            </span>
          </div>
        )}

        {/* NTE amount */}
        {workOrder.nte_amount != null && (
          <div className="flex items-center gap-2">
            <DollarSign className="w-3.5 h-3.5 text-accent-400 flex-shrink-0" />
            <span className="text-xs text-accent-500">Not to Exceed: </span>
            <span className="text-sm font-bold text-accent-900">
              ${workOrder.nte_amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        )}

        {/* Scope of work */}
        {workOrder.description && (
          <div className="pt-1 border-t border-accent-100">
            <p className="text-xs font-semibold text-accent-400 uppercase tracking-wider mb-1.5">Scope of Work</p>
            <p className="text-xs text-accent-600 leading-relaxed whitespace-pre-wrap">{workOrder.description}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Completion portal (existing) ──────────────────────────────────────────────

export function VendorPortal({
  token,
  workOrder,
  property,
  expired,
}: {
  token: string
  workOrder: WorkOrderInfo
  property: PropertyInfo | null
  expired: boolean
}) {
  const [notes, setNotes]       = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const alreadyDone = workOrder.status === 'completed' || workOrder.status === 'cancelled'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.set('notes', notes)
      const res = await fetch(`/api/work-orders/${token}/complete`, { method: 'POST', body: formData })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Something went wrong. Please try again.')
      } else {
        setSuccess(true)
      }
    } catch {
      setError('Network error. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PortalShell>
      {success ? (
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-green-600" />
          </div>
          <h2 className="text-xl font-semibold text-accent-900 mb-2">Work Order Complete!</h2>
          <p className="text-sm text-accent-500">Thank you. The property manager has been notified.</p>
          {notes && (
            <div className="mt-4 p-3 bg-accent-50 rounded-lg text-left">
              <p className="text-xs font-medium text-accent-500 mb-1">Your notes:</p>
              <p className="text-sm text-accent-700">{notes}</p>
            </div>
          )}
        </div>
      ) : expired ? (
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
            <Clock className="w-8 h-8 text-amber-600" />
          </div>
          <h2 className="text-xl font-semibold text-accent-900 mb-2">Link Expired</h2>
          <p className="text-sm text-accent-500">Contact the property manager for a new link.</p>
        </div>
      ) : alreadyDone ? (
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold text-accent-900 mb-2">
            Already {workOrder.status === 'completed' ? 'Completed' : 'Closed'}
          </h2>
          <p className="text-sm text-accent-500">
            This work order has already been {workOrder.status === 'completed' ? 'marked complete' : 'closed'}.
          </p>
        </div>
      ) : (
        <>
          <WOInfo workOrder={workOrder} property={property} />
          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="portal-notes" className="label">Completion Notes (optional)</label>
              <textarea
                id="portal-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="input resize-none"
                placeholder="Describe what was done, any issues found, parts used, etc."
              />
            </div>
            <button type="submit" disabled={submitting} className="w-full btn-primary py-3 text-base">
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Clock className="w-4 h-4 animate-spin" /> Submitting…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <CheckCircle2 className="w-4 h-4" /> Mark Complete
                </span>
              )}
            </button>
          </form>
        </>
      )}
    </PortalShell>
  )
}

// ── Quote portal (new) ────────────────────────────────────────────────────────

export function VendorQuotePortal({
  token,
  quoteRequestStatus,
  workOrder,
  property,
  expired,
}: {
  token:              string
  quoteRequestStatus: string
  workOrder:          WorkOrderInfo
  property:           PropertyInfo | null
  expired:            boolean
}) {
  const [amount, setAmount]     = useState('')
  const [notes, setNotes]       = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const alreadyQuoted = quoteRequestStatus !== 'pending'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = parseFloat(amount)
    if (!parsed || parsed <= 0) { setError('Please enter a valid quote amount.'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/work-orders/${token}/quote`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ amount: parsed, notes }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Something went wrong. Please try again.')
      } else {
        setSuccess(true)
      }
    } catch {
      setError('Network error. Please check your connection.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PortalShell>
      {success ? (
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-green-600" />
          </div>
          <h2 className="text-xl font-semibold text-accent-900 mb-2">Quote Submitted!</h2>
          <p className="text-sm text-accent-500">The property manager will review your quote and be in touch.</p>
          <div className="mt-4 p-3 bg-accent-50 rounded-lg text-left">
            <p className="text-xs text-accent-500 mb-1">Your quote:</p>
            <p className="text-2xl font-bold text-accent-900">${parseFloat(amount).toFixed(2)}</p>
            {notes && <p className="text-sm text-accent-600 mt-1">{notes}</p>}
          </div>
        </div>
      ) : expired ? (
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
            <Clock className="w-8 h-8 text-amber-600" />
          </div>
          <h2 className="text-xl font-semibold text-accent-900 mb-2">Link Expired</h2>
          <p className="text-sm text-accent-500">Contact the property manager for a new quote request.</p>
        </div>
      ) : alreadyQuoted ? (
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold text-accent-900 mb-2">Quote Already Submitted</h2>
          <p className="text-sm text-accent-500">Your quote has already been received. The property manager will be in touch.</p>
        </div>
      ) : (
        <>
          <p className="text-sm font-medium text-accent-700 mb-4">
            Please review the job details below and submit your quote.
          </p>
          <WOInfo workOrder={workOrder} property={property} />
          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="quote-amount" className="label">
                Your Quote <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-accent-400" />
                <input
                  id="quote-amount"
                  type="number"
                  min="1"
                  step="0.01"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="input pl-8"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div>
              <label htmlFor="quote-notes" className="label">Notes (optional)</label>
              <textarea
                id="quote-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="input resize-none"
                placeholder="Parts included, timeline, any conditions or questions…"
              />
            </div>
            <button type="submit" disabled={submitting} className="w-full btn-primary py-3 text-base">
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Clock className="w-4 h-4 animate-spin" /> Submitting…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <DollarSign className="w-4 h-4" /> Submit Quote
                </span>
              )}
            </button>
          </form>
        </>
      )}
    </PortalShell>
  )
}
