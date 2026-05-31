'use client'

import { useState } from 'react'
import { CheckCircle2, AlertTriangle, Clock, Calendar, Wrench, DollarSign } from 'lucide-react'

interface WorkOrderInfo {
  id: string
  title: string
  description: string | null
  status?: string
  scheduled_date: string | null
  estimated_cost: number | null
}

interface PropertyInfo {
  name: string
  city: string | null
  state: string | null
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
  return (
    <div className="bg-accent-50 rounded-xl p-4 mb-6 space-y-2">
      <div className="flex items-start gap-2">
        <Wrench className="w-4 h-4 text-accent-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-accent-900 text-sm">{workOrder.title}</p>
          {property && (
            <p className="text-xs text-accent-500 mt-0.5">
              {property.name}
              {(property.city || property.state) && (
                <span> &bull; {[property.city, property.state].filter(Boolean).join(', ')}</span>
              )}
            </p>
          )}
        </div>
      </div>
      {workOrder.scheduled_date && (
        <div className="flex items-center gap-2 text-xs text-accent-500">
          <Calendar className="w-3.5 h-3.5" />
          Target: {new Date(workOrder.scheduled_date).toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          })}
        </div>
      )}
      {workOrder.estimated_cost != null && (
        <div className="flex items-center gap-2 text-xs text-accent-500">
          <DollarSign className="w-3.5 h-3.5" />
          Budget estimate: ${workOrder.estimated_cost.toFixed(2)}
        </div>
      )}
      {workOrder.description && (
        <p className="text-xs text-accent-600 pt-1 border-t border-accent-200">
          {workOrder.description}
        </p>
      )}
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
