'use client'

import { useState } from 'react'
import { CheckCircle2, AlertTriangle, Clock, Calendar, Wrench, DollarSign, Check, Zap, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface WorkOrderInfo {
  id:             string
  title:          string
  description:    string | null
  status?:        string
  scheduled_date: string | null
  estimated_cost: number | null
  wo_number:      string | null
  category:       string | null
  priority:       string | null
  nte_amount:     number | null
  manual_url?:    string | null
}

interface PropertyInfo {
  name:    string
  address: string | null
  city:    string | null
  state:   string | null
  zip:     string | null
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
      <div className="bg-card-themed rounded-2xl shadow-[0_4px_24px_0_rgba(0,0,0,.10)] w-full max-w-md p-8">
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
  const categoryLabel  = workOrder.category ? (CATEGORY_LABELS[workOrder.category] ?? workOrder.category) : null
  const priorityStyle  = workOrder.priority ? (PRIORITY_STYLES[workOrder.priority] ?? PRIORITY_STYLES.low) : null
  const priorityLabel  = workOrder.priority
    ? workOrder.priority.charAt(0).toUpperCase() + workOrder.priority.slice(1)
    : null

  const addressLine = property?.address ?? null
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
            {workOrder.wo_number}
          </span>
        )}
      </div>

      <div className="bg-card-themed p-4 space-y-3">
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

        {/* Manufacturer's manual for this asset, if one's on file */}
        {workOrder.manual_url && (
          <a
            href={workOrder.manual_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 pt-1 border-t border-accent-100 text-xs font-semibold"
            style={{ color: 'var(--accent-blue)' }}
          >
            <BookOpen className="w-3.5 h-3.5 flex-shrink-0" />
            View manufacturer&apos;s service manual
          </a>
        )}
      </div>
    </div>
  )
}

// ── Completion portal (TradeSuite-branded) ────────────────────────────────────

export function VendorPortal({
  token,
  workOrder,
  property,
  expired,
  vendorConnectToken,
  vendorChargesEnabled,
}: {
  token:                string
  workOrder:            WorkOrderInfo
  property:             PropertyInfo | null
  expired:              boolean
  vendorConnectToken:   string
  vendorChargesEnabled: boolean
}) {
  const [notes,       setNotes]       = useState('')
  const [submitting,  setSubmitting]  = useState(false)
  const [success,     setSuccess]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [lineItems,   setLineItems]   = useState<LineItemInput[]>([
    { type: 'labor',    description: 'Labor', quantity: 1, unitCost: '' },
    { type: 'material', description: '',      quantity: 1, unitCost: '' },
  ])

  const alreadyDone = workOrder.status === 'completed' || workOrder.status === 'cancelled'

  const subtotal = lineItems.reduce((sum, item) => {
    const cost = parseFloat(item.unitCost) || 0
    return sum + (cost * item.quantity)
  }, 0)

  function addLineItem() {
    setLineItems((prev) => [...prev, { type: 'material', description: '', quantity: 1, unitCost: '' }])
  }

  function removeLineItem(idx: number) {
    setLineItems((prev) => prev.filter((_, i) => i !== idx))
  }

  function updateLineItem(idx: number, field: keyof LineItemInput, value: string | number) {
    setLineItems((prev) => prev.map((item, i) =>
      i === idx ? { ...item, [field]: value } : item
    ))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const validItems = lineItems.filter(
      (item) => item.description.trim() && (parseFloat(item.unitCost) || 0) > 0
    )

    if (validItems.length === 0) {
      setError('Add at least one line item with a description and cost.')
      return
    }

    if (subtotal <= 0) {
      setError('Invoice total must be greater than $0.')
      return
    }

    if (workOrder.nte_amount && subtotal > workOrder.nte_amount * 1.05) {
      setError(`Total of $${subtotal.toFixed(2)} exceeds the Not-to-Exceed amount of $${workOrder.nte_amount.toFixed(2)}. Please contact the property manager before submitting.`)
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/work-orders/${token}/complete`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          notes,
          lineItems: validItems.map((item) => ({
            line_type:   item.type,
            description: item.description.trim(),
            quantity:    item.quantity,
            unit_cost:   parseFloat(item.unitCost),
            line_total:  parseFloat(item.unitCost) * item.quantity,
          })),
          subtotal,
        }),
      })

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

  // ── TradeSuite shell ─────────────────────────────────────────────────────
  const shell = (children: React.ReactNode) => (
    <div style={{
      minHeight:       '100vh',
      backgroundColor: '#1A1A1A',
      backgroundImage: 'repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(255,255,255,0.015) 4px,rgba(255,255,255,0.015) 8px)',
      display:         'flex',
      alignItems:      'center',
      justifyContent:  'center',
      padding:         '16px',
      fontFamily:      '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    }}>
      <div style={{
        backgroundColor: '#ffffff',
        borderRadius:    16,
        width:           '100%',
        maxWidth:        480,
        overflow:        'hidden',
        boxShadow:       '0 24px 64px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{
          backgroundColor: '#1A1A1A',
          borderBottom:    '3px solid #FF6B00',
          padding:         '20px 24px',
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'space-between',
        }}>
          <div>
            <p style={{ color: '#FF6B00', fontSize: 16, fontWeight: 800, letterSpacing: '-0.3px', margin: 0 }}>
              TradeSuite
            </p>
            <p style={{ color: '#C0C0C0', fontSize: 10, margin: '2px 0 0', letterSpacing: '0.1em' }}>
              POWERED BY FIELDSTAY
            </p>
          </div>
          {workOrder.wo_number && (
            <span style={{ color: '#C0C0C0', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em' }}>
              {workOrder.wo_number}
            </span>
          )}
        </div>

        <div style={{ padding: '24px' }}>
          {children}
        </div>
      </div>
    </div>
  )

  // ── State: already done ──────────────────────────────────────────────────
  if (success) {
    return shell(
      <div style={{ textAlign: 'center', padding: '8px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <CheckCircle2 style={{ width: 48, height: 48, color: '#16a34a' }} />
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', margin: '0 0 8px' }}>
          Invoice Submitted!
        </h2>
        <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.6, margin: 0 }}>
          Your invoice has been sent to the property manager.
          Payment will be deposited to your Stripe payout account once approved.
        </p>
      </div>
    )
  }

  if (expired) {
    return shell(
      <div style={{ textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <Clock style={{ width: 36, height: 36, color: '#64748b' }} />
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', margin: '0 0 8px' }}>Link Expired</h2>
        <p style={{ fontSize: 14, color: '#64748b' }}>Contact the property manager for a new link.</p>
      </div>
    )
  }

  if (alreadyDone) {
    return shell(
      <div style={{ textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <Check style={{ width: 36, height: 36, color: '#16a34a' }} />
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', margin: '0 0 8px' }}>
          Already {workOrder.status === 'completed' ? 'Completed' : 'Closed'}
        </h2>
        <p style={{ fontSize: 14, color: '#64748b' }}>This work order has already been closed.</p>
      </div>
    )
  }

  // ── State: Connect gate ──────────────────────────────────────────────────
  if (!vendorChargesEnabled) {
    const onboardUrl = `/api/vendor-connect/${vendorConnectToken}/onboard`
    return shell(
      <>
        <WOInfo workOrder={workOrder} property={property} />
        <div style={{
          backgroundColor: '#fff7ed',
          border:          '1px solid #fed7aa',
          borderRadius:    10,
          padding:         '16px',
          marginBottom:    16,
        }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: '#9a3412', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Zap style={{ width: 16, height: 16, flexShrink: 0 }} /> Set up payouts before submitting
          </p>
          <p style={{ fontSize: 13, color: '#7c2d12', lineHeight: 1.55, margin: 0 }}>
            Invoices are paid via Stripe Connect directly to your bank.
            Setting up takes about 2 minutes — you&apos;ll need your bank details.
          </p>
        </div>
        <a
          href={onboardUrl}
          style={{
            display:         'block',
            backgroundColor: '#FF6B00',
            color:           '#ffffff',
            borderRadius:    10,
            padding:         '14px',
            fontSize:        15,
            fontWeight:      700,
            textAlign:       'center',
            textDecoration:  'none',
          }}
        >
          Set Up Stripe Payout Account →
        </a>
        <p style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', marginTop: 12 }}>
          Come back to this page after setup to submit your invoice.
        </p>
      </>
    )
  }

  // ── State: Line items form ───────────────────────────────────────────────
  return shell(
    <>
      <WOInfo workOrder={workOrder} property={property} />

      {error && (
        <div style={{
          backgroundColor: '#fef2f2',
          border:          '1px solid #fecaca',
          borderRadius:    8,
          padding:         '10px 12px',
          marginBottom:    16,
          fontSize:        13,
          color:           '#b91c1c',
        }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* Line items */}
        <p style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Invoice Line Items
        </p>

        <div style={{ display: 'flex', gap: 6, marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid #e5e7eb' }}>
          <span style={{ flex: '0 0 80px', fontSize: 10, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' }}>Type</span>
          <span style={{ flex: 1, fontSize: 10, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' }}>Description</span>
          <span style={{ flex: '0 0 50px', fontSize: 10, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', textAlign: 'right' }}>Qty</span>
          <span style={{ flex: '0 0 70px', fontSize: 10, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', textAlign: 'right' }}>Unit $</span>
          <span style={{ width: 24 }} />
        </div>

        {lineItems.map((item, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
            <select
              value={item.type}
              onChange={(e) => updateLineItem(idx, 'type', e.target.value)}
              style={{
                flex: '0 0 80px', fontSize: 12, padding: '6px 4px',
                border: '1px solid #d1d5db', borderRadius: 6, color: '#374151',
              }}
            >
              <option value="labor">Labor</option>
              <option value="material">Material</option>
              <option value="equipment">Equipment</option>
              <option value="subcontractor">Sub</option>
              <option value="other">Other</option>
            </select>

            <input
              type="text"
              value={item.description}
              onChange={(e) => updateLineItem(idx, 'description', e.target.value)}
              placeholder="Description"
              style={{
                flex: 1, fontSize: 13, padding: '6px 8px',
                border: '1px solid #d1d5db', borderRadius: 6, color: '#374151',
              }}
            />

            <input
              type="number"
              min="1"
              value={item.quantity}
              onChange={(e) => updateLineItem(idx, 'quantity', parseInt(e.target.value) || 1)}
              style={{
                flex: '0 0 50px', fontSize: 13, padding: '6px 4px',
                border: '1px solid #d1d5db', borderRadius: 6, textAlign: 'right', color: '#374151',
              }}
            />

            <div style={{ flex: '0 0 70px', position: 'relative' }}>
              <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontSize: 12 }}>$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={item.unitCost}
                onChange={(e) => updateLineItem(idx, 'unitCost', e.target.value)}
                placeholder="0.00"
                style={{
                  width: '100%', fontSize: 13, padding: '6px 6px 6px 18px',
                  border: '1px solid #d1d5db', borderRadius: 6, textAlign: 'right', color: '#374151',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <button
              type="button"
              onClick={() => removeLineItem(idx)}
              disabled={lineItems.length <= 1}
              style={{
                width: 24, height: 24, border: 'none', background: 'none',
                cursor: lineItems.length <= 1 ? 'not-allowed' : 'pointer',
                color: lineItems.length <= 1 ? '#d1d5db' : '#ef4444', fontSize: 16,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0,
              }}
            >
              ×
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={addLineItem}
          style={{
            fontSize: 13, color: '#FF6B00', background: 'none',
            border: '1px dashed #fed7aa', borderRadius: 6,
            padding: '6px 12px', cursor: 'pointer', marginBottom: 16, width: '100%',
          }}
        >
          + Add line item
        </button>

        {/* Total */}
        <div style={{
          backgroundColor: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          padding: '12px 16px',
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#374151' }}>Invoice Total</span>
          <span style={{ fontSize: 20, fontWeight: 800, color: '#0f172a' }}>
            ${subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>

        {workOrder.nte_amount != null && subtotal > workOrder.nte_amount && (
          <p style={{ fontSize: 12, color: '#b45309', backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 10px', marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} /> Total exceeds the Not-to-Exceed amount of ${workOrder.nte_amount.toFixed(2)}. Contact the PM before submitting.
          </p>
        )}

        {/* Completion notes */}
        <label htmlFor="completion-notes" style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
          Completion Notes <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</span>
        </label>
        <textarea
          id="completion-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Describe what was done, any issues found, parts used, follow-up needed…"
          style={{
            width: '100%', fontSize: 13, padding: '10px 12px',
            border: '1px solid #d1d5db', borderRadius: 8, resize: 'none',
            color: '#374151', boxSizing: 'border-box', marginBottom: 16,
          }}
        />

        <button
          type="submit"
          disabled={submitting || subtotal <= 0}
          style={{
            width: '100%', backgroundColor: submitting || subtotal <= 0 ? '#d1d5db' : '#FF6B00',
            color: '#ffffff', border: 'none', borderRadius: 10,
            padding: '14px', fontSize: 15, fontWeight: 700, cursor: submitting || subtotal <= 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? 'Submitting…' : `Submit Invoice — $${subtotal.toFixed(2)}`}
        </button>

        <p style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', marginTop: 10 }}>
          Payment processed via Stripe Connect · FieldStay · TradeSuite
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 6 }}>
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#94a3b8', textDecoration: 'underline' }}
          >
            Privacy
          </a>
          <span style={{ color: '#cbd5e1', fontSize: 11 }}>·</span>
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#94a3b8', textDecoration: 'underline' }}
          >
            Terms
          </a>
        </div>
      </form>
    </>
  )
}

// ── Line item state type ──────────────────────────────────────────────────────

interface LineItemInput {
  type:        'labor' | 'material' | 'equipment' | 'subcontractor' | 'other'
  description: string
  quantity:    number
  unitCost:    string  // string for controlled input
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
                <Input
                  id="quote-amount"
                  type="number"
                  min="1"
                  step="0.01"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="pl-8"
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
            <Button type="submit" disabled={submitting} className="w-full py-3 text-base">
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Clock className="w-4 h-4 animate-spin" /> Submitting…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <DollarSign className="w-4 h-4" /> Submit Quote
                </span>
              )}
            </Button>
          </form>
        </>
      )}
    </PortalShell>
  )
}
