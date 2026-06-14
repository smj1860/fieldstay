'use client'

import { useState, useTransition } from 'react'
import {
  MapPin, Wrench, Calendar, AlertTriangle, CheckCircle2,
  Circle, Key, Printer, Loader2, Hash, Tag, ChevronRight, ChevronDown,
  ShieldAlert, ClipboardList, User, Star, Camera, Send, Copy, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { LineItemsEditor, type WorkOrderLineItem } from './line-items-editor'
import {
  markVendorAcknowledged,
  markWorkVerified,
} from '@/app/(dashboard)/maintenance/work-order-actions'
import { rateWorkOrderVendor }         from '@/app/(dashboard)/maintenance/actions'
import { dispatchWorkOrderToVendor }   from '@/app/actions/work-order-public'

// ── Types ─────────────────────────────────────────────────────

type PriorityLevel   = 'low' | 'medium' | 'high' | 'urgent'
type WoStatus        = 'pending' | 'quote_requested' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'
type WoCategory      = 'hvac' | 'plumbing' | 'electrical' | 'appliance' | 'cleaning' |
                       'landscaping' | 'roofing' | 'flooring' | 'windows_doors' |
                       'pest_control' | 'pool' | 'structural' | 'general' | 'other'
type VendorSpecialty = 'plumbing' | 'electrical' | 'hvac' | 'landscaping' | 'cleaning' |
                       'pest_control' | 'pool' | 'roofing' | 'general' | 'other'
type MemberRole      = 'admin' | 'manager' | 'crew' | 'viewer'

export interface WorkOrderDetailData {
  id:                      string
  wo_number:               string | null
  org_id:                  string
  property_id:             string
  title:                   string
  description:             string | null
  category:                WoCategory | null
  priority:                PriorityLevel
  status:                  WoStatus
  source:                  string
  scheduled_date:          string | null
  completed_date:          string | null
  estimated_cost:          number | null
  nte_amount:              number | null
  actual_cost:             number | null
  access_notes:            string | null
  completion_notes:        string | null
  invoice_reference:       string | null
  vendor_acknowledged_at:  string | null
  completion_verified_at:  string | null
  created_at:              string
  // Relations
  properties: {
    name:                 string
    address:              string | null
    city:                 string | null
    state:                string | null
    access_instructions:  string | null
  }
  vendors: {
    id:        string
    name:      string
    specialty: VendorSpecialty
    email?:    string | null
  } | null
  // Public dispatch tracking
  vendor_dispatch_email?: string | null
  public_signed_off_at?:  string | null
  vendor_rating?:       number | null
  vendor_rating_notes?: string | null
  work_order_photos?: Array<{
    id:           string
    storage_path: string
  }>
  work_order_line_items?: WorkOrderLineItem[]
}

interface Props {
  workOrder:  WorkOrderDetailData
  userRole:   MemberRole
  onClose?:   () => void
}

// ── Display helpers ───────────────────────────────────────────

const PRIORITY_STYLES: Record<PriorityLevel, { badge: string; label: string }> = {
  urgent: { badge: 'bg-red-500/15 text-red-400 border border-red-500/30',   label: 'URGENT'  },
  high:   { badge: 'bg-orange-500/15 text-orange-400 border border-orange-500/30', label: 'HIGH'    },
  medium: { badge: 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30', label: 'MEDIUM'  },
  low:    { badge: 'bg-slate-500/15 text-slate-400 border border-slate-500/30',     label: 'LOW'     },
}

const STATUS_STYLES: Record<WoStatus, { dot: string; label: string }> = {
  pending:         { dot: 'bg-slate-400',   label: 'Pending'         },
  quote_requested: { dot: 'bg-purple-400',  label: 'Quote Requested' },
  assigned:        { dot: 'bg-blue-400',    label: 'Assigned'        },
  in_progress:     { dot: 'bg-yellow-400',  label: 'In Progress'     },
  completed:       { dot: 'bg-emerald-400', label: 'Completed'       },
  cancelled:       { dot: 'bg-red-400',     label: 'Cancelled'       },
}

const CATEGORY_LABELS: Record<WoCategory, string> = {
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
  pool:          'Pool',
  structural:    'Structural',
  general:       'General',
  other:         'Other',
}

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })
}

// ── Component ─────────────────────────────────────────────────

export function WorkOrderDetail({ workOrder: wo, userRole, onClose }: Props) {
  const [isPending, startTransition] = useTransition()
  const [actionError, setActionError] = useState<string | null>(null)
  const [nteOverrideConfirmed, setNteOverrideConfirmed] = useState(false)
  const [hoverRating, setHoverRating] = useState(0)
  const [savedRating, setSavedRating] = useState<number | null>(wo.vendor_rating ?? null)
  const [ratingNotes, setRatingNotes] = useState(wo.vendor_rating_notes ?? '')
  const [ratingPending, startRatingTransition] = useTransition()
  const [ratingError, setRatingError] = useState<string | null>(null)
  const [ratingSuccess, setRatingSuccess] = useState(false)

  // Dispatch modal state
  const [showDispatch,    setShowDispatch]    = useState(false)
  const [dispatchEmail,   setDispatchEmail]   = useState(wo.vendors?.email ?? wo.vendor_dispatch_email ?? '')
  const [dispatchName,    setDispatchName]    = useState(wo.vendors?.name ?? '')
  const [dispatching,     setDispatching]     = useState(false)
  const [dispatchError,   setDispatchError]   = useState<string | null>(null)
  const [dispatchedUrl,   setDispatchedUrl]   = useState<string | null>(null)
  const [copied,          setCopied]          = useState(false)

  const canEdit  = userRole === 'admin' || userRole === 'manager'
  const priority = PRIORITY_STYLES[wo.priority]
  const status   = STATUS_STYLES[wo.status]

  const lineItems      = wo.work_order_line_items ?? []
  const hasAccess      = !!(wo.properties.access_instructions || wo.access_notes)
  const lineItemsTotal = lineItems.reduce((s, i) => s + i.line_total, 0)

  const nteSet      = wo.nte_amount != null && wo.nte_amount > 0
  const nteExceeded = nteSet && lineItemsTotal > wo.nte_amount!
  const nteOverage  = nteExceeded ? lineItemsTotal - wo.nte_amount! : 0

  // ── Action handlers ──────────────────────────────────────────

  function handleAcknowledge() {
    setActionError(null)
    startTransition(async () => {
      try { await markVendorAcknowledged(wo.id) }
      catch (e) { setActionError(e instanceof Error ? e.message : 'Failed.') }
    })
  }

  function handleVerify() {
    setActionError(null)
    startTransition(async () => {
      try { await markWorkVerified(wo.id) }
      catch (e) { setActionError(e instanceof Error ? e.message : 'Failed.') }
    })
  }

  function handleRating(star: number) {
    setSavedRating(star)
    setRatingError(null)
    setRatingSuccess(false)
    startRatingTransition(async () => {
      try {
        await rateWorkOrderVendor(wo.id, star as 1 | 2 | 3 | 4 | 5, ratingNotes)
        setRatingSuccess(true)
      } catch (e) {
        setRatingError(e instanceof Error ? e.message : 'Failed to save rating.')
      }
    })
  }

  function handleRatingNotesSave() {
    if (!savedRating) return
    handleRating(savedRating)
  }

  async function handleDispatch() {
    if (!dispatchEmail.trim()) return
    setDispatching(true)
    setDispatchError(null)
    const result = await dispatchWorkOrderToVendor({
      workOrderId: wo.id,
      vendorEmail: dispatchEmail.trim(),
      vendorName:  dispatchName.trim() || 'Contractor',
    })
    setDispatching(false)
    if (result.error) {
      setDispatchError(result.error)
      return
    }
    if (result.publicUrl) {
      setDispatchedUrl(result.publicUrl)
    }
  }

  function handleCopyUrl() {
    if (!dispatchedUrl) return
    navigator.clipboard.writeText(dispatchedUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // ── Render ───────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-full overflow-y-auto print:overflow-visible"
      style={{ background: 'var(--bg-base)' }}
    >
      {/* ── Document Header ───────────────────────────────────── */}
      <div
        className="flex-shrink-0 flex items-start justify-between px-6 pt-6 pb-5 print:pt-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="space-y-0.5">
          {/* Brand mark */}
          <p className="text-xs font-semibold uppercase tracking-widest"
             style={{ color: 'var(--accent-gold)' }}>
            FieldStay
          </p>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            Work Order
          </h2>
        </div>

        <div className="flex items-start gap-3">
          {/* WO number */}
          <div className="text-right">
            <div
              className="flex items-center gap-1.5 font-mono font-bold text-xl"
              style={{ color: 'var(--text-primary)' }}
            >
              <Hash className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
              {wo.wo_number ?? '—'}
            </div>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Issued {fmtDate(wo.created_at)}
            </p>
          </div>

          {/* Send to Vendor button */}
          {canEdit && wo.status !== 'cancelled' && !wo.public_signed_off_at && (
            <button
              onClick={() => setShowDispatch(true)}
              className="print:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={{
                background: 'rgba(255,107,0,0.1)',
                color:      '#FF6B00',
                border:     '1px solid rgba(255,107,0,0.3)',
              }}
              title="Send work order to vendor"
            >
              <Send className="w-3.5 h-3.5" />
              Send to Vendor
            </button>
          )}

          {/* Print button */}
          <button
            onClick={() => window.print()}
            className="print:hidden p-2 rounded-lg transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title="Print work order"
          >
            <Printer className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 px-6 py-5 space-y-6 print:space-y-4">

        {/* ── Info Grid: Property + Vendor ──────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

          {/* Property */}
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-widest"
               style={{ color: 'var(--text-muted)' }}>
              Property
            </p>
            <div className="flex items-start gap-2">
              <MapPin className="w-4 h-4 flex-shrink-0 mt-0.5"
                      style={{ color: 'var(--accent-gold)' }} />
              <div>
                <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                  {wo.properties.name}
                </p>
                {wo.properties.address && (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    {wo.properties.address}
                  </p>
                )}
                {(wo.properties.city || wo.properties.state) && (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    {[wo.properties.city, wo.properties.state].filter(Boolean).join(', ')}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Assigned vendor + dates */}
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-widest"
                 style={{ color: 'var(--text-muted)' }}>
                Assigned To
              </p>
              <div className="flex items-start gap-2">
                <User className="w-4 h-4 flex-shrink-0 mt-0.5"
                      style={{ color: 'var(--accent-gold)' }} />
                {wo.vendors ? (
                  <div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                      {wo.vendors.name}
                    </p>
                    <p className="text-sm capitalize" style={{ color: 'var(--text-muted)' }}>
                      {wo.vendors.specialty.replace('_', ' ')}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm italic" style={{ color: 'var(--text-muted)' }}>
                    Unassigned
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-widest"
                 style={{ color: 'var(--text-muted)' }}>
                Schedule
              </p>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 flex-shrink-0"
                          style={{ color: 'var(--accent-gold)' }} />
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {wo.scheduled_date ? (
                    <>Due: <span className="font-medium">{fmtDate(wo.scheduled_date)}</span></>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>No due date set</span>
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Status Strip ──────────────────────────────────────── */}
        <div
          className="flex flex-wrap items-center gap-2 py-3 px-4 rounded-lg"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
        >
          {/* Priority */}
          <span className={cn('px-2.5 py-1 rounded-md text-xs font-bold tracking-wide', priority.badge)}>
            {priority.label}
          </span>

          <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--border)' }} />

          {/* Status */}
          <span className="flex items-center gap-1.5 text-sm font-medium"
                style={{ color: 'var(--text-primary)' }}>
            <span className={cn('w-2 h-2 rounded-full flex-shrink-0', status.dot)} />
            {status.label}
          </span>

          {wo.category && (
            <>
              <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--border)' }} />
              <span className="flex items-center gap-1.5 text-sm"
                    style={{ color: 'var(--text-muted)' }}>
                <Tag className="w-3.5 h-3.5" />
                {CATEGORY_LABELS[wo.category]}
              </span>
            </>
          )}

          {wo.invoice_reference && (
            <span className="ml-auto text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
              Invoice: {wo.invoice_reference}
            </span>
          )}
        </div>

        {/* ── NTE Banner ────────────────────────────────────────── */}
        {wo.nte_amount != null && (
          <div
            className="flex items-start gap-3 px-4 py-3 rounded-lg"
            style={{
              background:  'rgb(234 179 8 / 0.08)',
              border:      '1px solid rgb(234 179 8 / 0.25)',
            }}
          >
            <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5 text-yellow-400" />
            <div>
              <p className="text-sm font-semibold text-yellow-400">
                Authorized Limit (NTE): {fmt(wo.nte_amount)}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Contractor must obtain written approval before exceeding this amount.
              </p>
            </div>
          </div>
        )}

        {/* ── Scope of Work ─────────────────────────────────────── */}
        <Section icon={<ClipboardList className="w-4 h-4" />} title="Scope of Work">
          <p className="text-sm leading-relaxed whitespace-pre-wrap"
             style={{ color: wo.description ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            {wo.description ?? 'No description provided.'}
          </p>
          {(wo.estimated_cost != null && wo.nte_amount == null) && (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              Estimated cost: <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                {fmt(wo.estimated_cost)}
              </span>
            </p>
          )}
        </Section>

        {/* ── Property Access ───────────────────────────────────── */}
        {hasAccess && (
          <Section icon={<Key className="w-4 h-4" />} title="Property Access" mobileCollapse defaultOpen={false}>
            {wo.properties.access_instructions && (
              <p className="text-sm leading-relaxed whitespace-pre-wrap"
                 style={{ color: 'var(--text-primary)' }}>
                {wo.properties.access_instructions}
              </p>
            )}
            {wo.access_notes && (
              <div
                className={cn('text-sm leading-relaxed whitespace-pre-wrap',
                  wo.properties.access_instructions && 'mt-2 pt-2')}
                style={{
                  color:       'var(--text-primary)',
                  borderTop:   wo.properties.access_instructions
                               ? '1px dashed var(--border)' : undefined,
                }}
              >
                <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  Note:{' '}
                </span>
                {wo.access_notes}
              </div>
            )}
          </Section>
        )}

        {/* ── Materials & Labor ─────────────────────────────────── */}
        <Section
          icon={<Wrench className="w-4 h-4" />}
          title="Materials & Labor"
          mobileCollapse
          defaultOpen={false}
          action={
            wo.actual_cost != null && lineItems.length > 0 ? (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Total: <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {fmt(wo.actual_cost)}
                </span>
              </span>
            ) : undefined
          }
        >
          <LineItemsEditor
            workOrderId={wo.id}
            items={lineItems}
            canEdit={canEdit && wo.status !== 'completed' && wo.status !== 'cancelled'}
          />

          {nteSet && (
            <div
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm mt-2',
                nteExceeded ? 'border border-red-200' : 'border border-green-200'
              )}
              style={{
                background: nteExceeded ? 'rgba(220,38,38,0.07)' : 'rgba(16,185,129,0.07)',
              }}
            >
              {nteExceeded ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
                  <span className="font-medium text-red-700">
                    Exceeds NTE by{' '}
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(nteOverage)}
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                  <span className="text-green-700">
                    Within NTE (
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(wo.nte_amount! - lineItemsTotal)}{' '}
                    remaining)
                  </span>
                </>
              )}
            </div>
          )}
        </Section>

        {/* ── Completion & Sign-Off ─────────────────────────────── */}
        <Section
          icon={<CheckCircle2 className="w-4 h-4" />}
          title="Completion & Sign-Off"
        >
          <div className="space-y-3">

            {/* Vendor acknowledged */}
            <SignOffRow
              label="Vendor Acknowledged"
              timestamp={wo.vendor_acknowledged_at}
              canAction={canEdit && !wo.vendor_acknowledged_at && wo.status !== 'cancelled'}
              isPending={isPending}
              onAction={handleAcknowledge}
              actionLabel="Mark Acknowledged"
            />

            {/* NTE override checkbox */}
            {nteExceeded && canEdit && !wo.completion_verified_at && (
              <label
                className="flex items-start gap-2 text-sm cursor-pointer p-3 rounded-lg"
                style={{
                  background: 'rgba(220,38,38,0.07)',
                  border:     '1px solid rgba(220,38,38,0.25)',
                }}
              >
                <input
                  type="checkbox"
                  checked={nteOverrideConfirmed}
                  onChange={e => setNteOverrideConfirmed(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded text-red-600 focus:ring-red-500"
                />
                <span style={{ color: '#991b1b', fontWeight: 500 }}>
                  I authorize this work order to exceed the NTE amount and confirm the additional cost of{' '}
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(nteOverage)}.
                </span>
              </label>
            )}

            {/* PM verified */}
            <SignOffRow
              label="Work Verified Complete"
              timestamp={wo.completion_verified_at}
              canAction={canEdit && !wo.completion_verified_at && !!wo.vendor_acknowledged_at && (!nteExceeded || nteOverrideConfirmed)}
              isPending={isPending}
              onAction={handleVerify}
              actionLabel="Mark Verified"
            />

            {/* Completion notes */}
            {wo.completion_notes && (
              <p className="text-sm mt-1 pt-3 leading-relaxed"
                 style={{
                   color:       'var(--text-muted)',
                   borderTop:   '1px solid var(--border)',
                 }}>
                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  Notes:{' '}
                </span>
                {wo.completion_notes}
              </p>
            )}

            {actionError && (
              <p className="text-xs text-red-400">{actionError}</p>
            )}
          </div>
        </Section>

        {/* ── Photos ────────────────────────────────────────────── */}
        {(wo.work_order_photos ?? []).length > 0 && (
          <Section icon={<Camera className="w-4 h-4" />} title="Photos" mobileCollapse defaultOpen={false}>
            <div className="flex flex-wrap gap-2">
              {wo.work_order_photos!.map(photo => {
                const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/work-order-photos/${photo.storage_path}`
                return (
                  <a
                    key={photo.id}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block w-20 h-20 rounded-lg overflow-hidden flex-shrink-0"
                    style={{ border: '1px solid var(--border)' }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt="Work order photo"
                      className="w-full h-full object-cover"
                    />
                  </a>
                )
              })}
            </div>
          </Section>
        )}

        {/* ── Vendor Rating ─────────────────────────────────────── */}
        {wo.status === 'completed' && wo.vendors && canEdit && (
          <Section icon={<Star className="w-4 h-4" />} title="Vendor Rating" mobileCollapse defaultOpen={false}>
            <div className="space-y-3">
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map(star => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => handleRating(star)}
                    onMouseEnter={() => setHoverRating(star)}
                    onMouseLeave={() => setHoverRating(0)}
                    disabled={ratingPending}
                    className="p-0.5 transition-transform hover:scale-110"
                  >
                    <Star
                      className="w-6 h-6"
                      style={{
                        color: star <= (hoverRating || savedRating || 0)
                          ? 'var(--accent-gold)'
                          : 'var(--border)',
                        fill: star <= (hoverRating || savedRating || 0)
                          ? 'var(--accent-gold)'
                          : 'transparent',
                      }}
                    />
                  </button>
                ))}
                {savedRating && (
                  <span className="ml-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                    {savedRating}/5
                  </span>
                )}
                {ratingPending && <Loader2 className="w-4 h-4 ml-2 animate-spin" style={{ color: 'var(--text-muted)' }} />}
              </div>

              <div className="space-y-1.5">
                <textarea
                  value={ratingNotes}
                  onChange={e => setRatingNotes(e.target.value)}
                  placeholder="Optional notes about the vendor's performance…"
                  rows={2}
                  className="input w-full text-sm resize-none"
                />
                <button
                  type="button"
                  onClick={handleRatingNotesSave}
                  disabled={ratingPending || !savedRating}
                  className="btn-secondary text-xs py-1 px-3"
                >
                  Save Notes
                </button>
              </div>

              {ratingSuccess && (
                <p className="text-xs" style={{ color: 'var(--accent-green)' }}>Rating saved.</p>
              )}
              {ratingError && (
                <p className="text-xs text-red-400">{ratingError}</p>
              )}
            </div>
          </Section>
        )}
      </div>

      {/* ── Dispatch Modal ────────────────────────────────────── */}
      {showDispatch && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 print:hidden"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowDispatch(false) }}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 space-y-4"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
                  Send to Vendor
                </h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Vendor receives a magic link to view and sign off this work order
                </p>
              </div>
              <button
                onClick={() => { setShowDispatch(false); setDispatchedUrl(null); setDispatchError(null) }}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {!dispatchedUrl ? (
              <>
                {/* Vendor email */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                    Vendor Email *
                  </label>
                  <input
                    type="email"
                    value={dispatchEmail}
                    onChange={e => setDispatchEmail(e.target.value)}
                    placeholder="vendor@company.com"
                    className="input w-full text-sm"
                  />
                </div>

                {/* Vendor name */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                    Vendor Name
                  </label>
                  <input
                    type="text"
                    value={dispatchName}
                    onChange={e => setDispatchName(e.target.value)}
                    placeholder="e.g. Mike Johnson"
                    className="input w-full text-sm"
                  />
                </div>

                {dispatchError && (
                  <p className="text-xs text-red-400">{dispatchError}</p>
                )}

                <button
                  onClick={handleDispatch}
                  disabled={dispatching || !dispatchEmail.trim()}
                  className="w-full btn flex items-center justify-center gap-2 py-2.5 text-sm font-semibold"
                  style={{
                    background: '#1A1A1A',
                    color:      '#F0F0F0',
                    border:     '2px solid #FF6B00',
                    borderRadius: 12,
                    opacity: (dispatching || !dispatchEmail.trim()) ? 0.6 : 1,
                  }}
                >
                  {dispatching ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  {dispatching ? 'Sending…' : 'Send Work Order'}
                </button>
              </>
            ) : (
              <>
                {/* Success state */}
                <div
                  className="rounded-xl p-4 space-y-3"
                  style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}
                >
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                    <p className="text-sm font-semibold text-emerald-400">
                      Work order sent to {dispatchEmail}
                    </p>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    The vendor will receive an email with a magic link. Link expires in 30 days.
                  </p>
                </div>

                {/* Copy link */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                    Magic Link (shareable)
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={dispatchedUrl}
                      className="input flex-1 text-xs font-mono"
                      onClick={e => (e.target as HTMLInputElement).select()}
                    />
                    <button
                      onClick={handleCopyUrl}
                      className="p-2 rounded-lg flex-shrink-0 transition-colors"
                      style={{
                        background: copied ? 'rgba(16,185,129,0.15)' : 'var(--bg-raised)',
                        border:     '1px solid var(--border)',
                        color:      copied ? '#34D399' : 'var(--text-muted)',
                      }}
                      title="Copy link"
                    >
                      {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  onClick={() => { setShowDispatch(false); setDispatchedUrl(null) }}
                  className="w-full btn-secondary text-sm py-2"
                >
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Section wrapper ───────────────────────────────────────────

function Section({
  icon,
  title,
  action,
  mobileCollapse = false,
  defaultOpen = true,
  children,
}: {
  icon:            React.ReactNode
  title:           string
  action?:         React.ReactNode
  mobileCollapse?: boolean
  defaultOpen?:    boolean
  children:        React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  const header = (
    <>
      <div className="flex items-center gap-2">
        <span style={{ color: 'var(--accent-gold)' }}>{icon}</span>
        <h3 className="text-xs font-semibold uppercase tracking-widest"
            style={{ color: 'var(--text-muted)' }}>
          {title}
        </h3>
      </div>
      <div className="flex items-center gap-2">
        {action}
        {mobileCollapse && (
          <ChevronDown
            className={cn('w-4 h-4 transition-transform md:hidden', open && 'rotate-180')}
            style={{ color: 'var(--text-muted)' }}
          />
        )}
      </div>
    </>
  )

  return (
    <div className="space-y-3">
      {mobileCollapse ? (
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center justify-between w-full text-left md:cursor-default"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center justify-between">
          {header}
        </div>
      )}
      <div
        className={cn('pl-4 ml-2', mobileCollapse && !open && 'hidden md:block')}
        style={{ borderLeft: '2px solid var(--border)' }}
      >
        {children}
      </div>
    </div>
  )
}

// ── Sign-off row ──────────────────────────────────────────────

function SignOffRow({
  label,
  timestamp,
  canAction,
  isPending,
  onAction,
  actionLabel,
}: {
  label:       string
  timestamp:   string | null
  canAction:   boolean
  isPending:   boolean
  onAction:    () => void
  actionLabel: string
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5">
        {timestamp ? (
          <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-400" />
        ) : (
          <Circle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--border)' }} />
        )}
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {label}
          </p>
          {timestamp && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {fmtDate(timestamp)}
            </p>
          )}
        </div>
      </div>

      {canAction && (
        <button
          onClick={onAction}
          disabled={isPending}
          className="btn btn-ghost text-xs flex-shrink-0 print:hidden"
          style={{ color: 'var(--accent-gold)' }}
        >
          {isPending
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : actionLabel}
        </button>
      )}
    </div>
  )
}
