'use client'

import { useState } from 'react'
import {
  MapPin, Wrench, Calendar, AlertTriangle, CheckCircle2,
  Circle, Key, Printer, Loader2, Hash, Tag, ChevronRight, ChevronDown,
  ShieldAlert, ClipboardList, User, Star, Camera, Send, Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { LineItemsEditor, type WorkOrderLineItem } from './line-items-editor'
import { useWorkOrderActions } from './use-work-order-actions'
import { CancelConfirmDialog } from './CancelConfirmDialog'
import { VendorDispatchDialog } from './VendorDispatchDialog'
import { VendorRatingPanel } from './VendorRatingPanel'

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
  invoiceStatus?:          'pending_payment' | 'paid' | 'cancelled' | null
  invoiceId?:              string | null
  vendor_acknowledged_at:  string | null
  completion_verified_at:  string | null
  reported_by_crew_name?:  string | null
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
    phone?:    string | null
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
  vendors?:   { id: string; name: string; email: string | null }[]
}

// ── Display helpers ───────────────────────────────────────────

const PRIORITY_STYLES: Record<PriorityLevel, { badge: string; label: string }> = {
  urgent: { badge: 'bg-[var(--accent-red-dim)] text-[var(--accent-red)] border border-[var(--accent-red)]', label: 'URGENT'  },
  high:   { badge: 'bg-orange-500/15 text-orange-400 border border-orange-500/30', label: 'HIGH'    },
  medium: { badge: 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30', label: 'MEDIUM'  },
  low:    { badge: 'bg-slate-500/15 text-slate-400 border border-slate-500/30',     label: 'LOW'     },
}

const STATUS_STYLES: Record<WoStatus, { dot: string; label: string }> = {
  pending:         { dot: 'bg-slate-400',   label: 'Pending'         },
  quote_requested: { dot: 'bg-[var(--accent-purple)]', label: 'Quote Requested' },
  assigned:        { dot: 'bg-blue-400',    label: 'Assigned'        },
  in_progress:     { dot: 'bg-yellow-400',  label: 'In Progress'     },
  completed:       { dot: 'bg-emerald-400', label: 'Completed'       },
  cancelled:       { dot: 'bg-red-400',     label: 'Cancelled'       },
}

const INVOICE_STATUS_STYLES: Record<'pending_payment' | 'paid' | 'cancelled', { badge: string; label: React.ReactNode }> = {
  paid:            { badge: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30', label: <span className="inline-flex items-center gap-1"><Check className="w-3 h-3" /> Paid</span> },
  pending_payment: { badge: 'bg-[var(--accent-amber-dim)] text-[var(--accent-amber)] border border-[var(--accent-amber)]', label: 'Pending Payment →' },
  cancelled:       { badge: 'bg-slate-500/15 text-slate-400 border border-slate-500/30 line-through', label: 'Cancelled' },
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

export function WorkOrderDetail({ workOrder: wo, userRole, vendors = [] }: Readonly<Props>) {
  const actions = useWorkOrderActions(wo)
  const {
    isPending, actionError,
    nteOverrideConfirmed, setNteOverrideConfirmed,
    showCancelConfirm, setShowCancelConfirm,
    showDispatch, setShowDispatch, setDispatchedUrl, setDispatchError,
    handleAcknowledge, handleVerify, handleCancel,
  } = actions

  const canEdit  = userRole === 'admin' || userRole === 'manager'
  const priority = PRIORITY_STYLES[wo.priority]
  const status   = STATUS_STYLES[wo.status]
  const canCancel = canEdit && wo.status !== 'completed' && wo.status !== 'cancelled'

  const lineItems      = wo.work_order_line_items ?? []
  const hasAccess      = !!(wo.properties.access_instructions || wo.access_notes)
  const lineItemsTotal = lineItems.reduce((s, i) => s + i.line_total, 0)

  const nteSet      = wo.nte_amount != null && wo.nte_amount > 0
  const nteExceeded = nteSet && lineItemsTotal > wo.nte_amount!
  const nteOverage  = nteExceeded ? lineItemsTotal - wo.nte_amount! : 0

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
            {wo.reported_by_crew_name && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Reported by {wo.reported_by_crew_name}
              </p>
            )}
          </div>

          {/* Send to Vendor button */}
          {canEdit && wo.status !== 'cancelled' && !wo.public_signed_off_at && (
            <button
              onClick={() => setShowDispatch(true)}
              className="print:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={{
                background: 'var(--accent-gold-dim)',
                color:      'var(--accent-gold)',
                border:     '1px solid var(--accent-gold)',
              }}
              title="Send work order to vendor"
            >
              <Send className="w-3.5 h-3.5" />
              Send to Vendor
            </button>
          )}

          {/* Cancel Work Order button */}
          {canCancel && (
            <Button
              type="button"
              variant="danger"
              onClick={() => setShowCancelConfirm(true)}
              disabled={isPending}
              className="print:hidden text-xs py-1.5 px-3"
              title="Cancel this work order"
            >
              Cancel Work Order
            </Button>
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

          {wo.invoiceStatus && wo.invoiceId ? (
            <a
              href={`/invoices/${wo.invoiceId}`}
              className={cn(
                'ml-auto px-2.5 py-1 rounded-md text-xs font-bold tracking-wide',
                INVOICE_STATUS_STYLES[wo.invoiceStatus].badge
              )}
            >
              {INVOICE_STATUS_STYLES[wo.invoiceStatus].label}
            </a>
          ) : wo.invoice_reference && (
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
                nteExceeded ? 'border border-[var(--accent-red)]' : 'border border-[var(--accent-green)]'
              )}
              style={{
                background: nteExceeded ? 'var(--accent-red-dim)' : 'var(--accent-green-dim)',
              }}
            >
              {nteExceeded ? (
                <>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-red)' }} />
                  <span className="font-medium" style={{ color: 'var(--accent-red)' }}>
                    Exceeds NTE by{' '}
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(nteOverage)}
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
                  <span style={{ color: 'var(--accent-green)' }}>
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
                  className="mt-0.5 w-4 h-4 rounded text-[var(--accent-red)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
                />
                <span style={{ color: 'var(--accent-red)', fontWeight: 500 }}>
                  I authorize this work order to exceed the NTE amount and confirm the additional cost of{' '}
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(nteOverage)}.
                </span>
              </label>
            )}

            {/* PM verified — vendor-assigned work orders are completed through
                the vendor's own portal (line items → invoice → Stripe payout),
                not verified here, so this action is unavailable once a vendor
                is assigned. */}
            <SignOffRow
              label="Work Verified Complete"
              timestamp={wo.completion_verified_at}
              canAction={canEdit && !wo.vendors && !wo.completion_verified_at && !!wo.vendor_acknowledged_at && (!nteExceeded || nteOverrideConfirmed)}
              isPending={isPending}
              onAction={handleVerify}
              actionLabel="Mark Verified"
            />
            {!!wo.vendors && !wo.completion_verified_at && (
              <p className="text-xs italic" style={{ color: 'var(--text-muted)' }}>
                Assigned to a vendor — completed through their portal, which generates the invoice and Stripe payout automatically.
              </p>
            )}

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
              <p className="text-xs" style={{ color: 'var(--accent-red)' }}>{actionError}</p>
            )}
          </div>
        </Section>

        {/* ── Photos ────────────────────────────────────────────── */}
        {(wo.work_order_photos ?? []).length > 0 && (
          <Section icon={<Camera className="w-4 h-4" />} title="Photos" mobileCollapse defaultOpen={false}>
            <div className="flex flex-wrap gap-2">
              {wo.work_order_photos!.map((photo, index) => {
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
                      alt={`Work order photo ${index + 1} of ${wo.work_order_photos!.length}`}
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
            <VendorRatingPanel actions={actions} />
          </Section>
        )}
      </div>

      {/* ── Cancel Confirmation Modal ─────────────────────────── */}
      {showCancelConfirm && (
        <CancelConfirmDialog
          woNumber={wo.wo_number}
          actionError={actionError}
          isPending={isPending}
          onConfirm={handleCancel}
          onClose={() => setShowCancelConfirm(false)}
        />
      )}

      {/* ── Dispatch Modal ────────────────────────────────────── */}
      {showDispatch && (
        <VendorDispatchDialog
          vendorDispatchEmail={wo.vendor_dispatch_email}
          vendors={vendors}
          actions={actions}
          onClose={() => { setShowDispatch(false); setDispatchedUrl(null); setDispatchError(null) }}
        />
      )}
    </div>
  )
}

// ── Section wrapper ───────────────────────────────────────────

interface SectionProps {
  icon:            React.ReactNode
  title:           string
  action?:         React.ReactNode
  mobileCollapse?: boolean
  defaultOpen?:    boolean
  children:        React.ReactNode
}

function Section({
  icon,
  title,
  action,
  mobileCollapse = false,
  defaultOpen = true,
  children,
}: Readonly<SectionProps>) {
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

interface SignOffRowProps {
  label:       string
  timestamp:   string | null
  canAction:   boolean
  isPending:   boolean
  onAction:    () => void
  actionLabel: string
}

function SignOffRow({
  label,
  timestamp,
  canAction,
  isPending,
  onAction,
  actionLabel,
}: Readonly<SignOffRowProps>) {
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
        <Button
          variant="ghost"
          onClick={onAction}
          disabled={isPending}
          className="text-xs flex-shrink-0 print:hidden"
          style={{ color: 'var(--accent-gold)' }}
        >
          {isPending
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : actionLabel}
        </Button>
      )}
    </div>
  )
}
