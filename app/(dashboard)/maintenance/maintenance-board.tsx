'use client'

import { useState, useTransition, useActionState, useRef, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Plus, ChevronDown, X, Wrench, Calendar, DollarSign,
  User, ChevronRight, AlertTriangle, CheckCircle2, Clock,
  Pencil, Trash2, Camera, List, BarChart2, Send, LayoutGrid, Loader2,
} from 'lucide-react'
import { cn, formatDate, WO_STATUS_LABELS } from '@/lib/utils'
import {
  createWorkOrder, createWorkOrderFromSchedule,
  createMaintenanceSchedule, updateMaintenanceSchedule, deleteMaintenanceSchedule,
  broadcastMaintenanceTemplate, createMaintenanceScheduleTemplate, updateMaintenanceTemplate, type BroadcastResult,
  bulkAssignVendor, bulkUpdateWorkOrderStatus, fetchArchivedWorkOrders,
} from './actions'
import type { WoStatus, PriorityLevel, VendorSpecialty, ScheduleType, ScheduleFrequency, ComplianceStatus } from '@/types/database'
import { distanceMiles } from '@/lib/geocoding'
import { WorkOrderDetail, type WorkOrderDetailData } from '@/components/work-orders/work-order-detail'
import { MaintenanceCalendar } from './maintenance-calendar'
import { createClient } from '@/lib/supabase/client'

// ── Local types ───────────────────────────────────────────────────────────────

interface WorkOrderRow {
  id: string
  property_id: string
  vendor_id: string | null
  wo_number: string | null
  title: string
  description: string | null
  category: string | null
  priority: PriorityLevel
  status: WoStatus
  scheduled_date: string | null
  completed_date: string | null
  estimated_cost: number | null
  nte_amount: number | null
  actual_cost: number | null
  access_notes: string | null
  portal_enabled: boolean
  completion_token: string | null
  completion_notes: string | null
  invoice_reference: string | null
  vendor_acknowledged_at: string | null
  vendor_acknowledged_by: string | null
  completion_verified_at: string | null
  completion_verified_by: string | null
  vendor_dispatch_email: string | null
  created_at: string
  updated_at: string
  properties: { name: string; address: string | null; city: string | null; state: string | null; access_instructions: string | null } | { name: string; address: string | null; city: string | null; state: string | null; access_instructions: string | null }[] | null
  vendors: { id: string; name: string; specialty: string; phone: string | null } | { id: string; name: string; specialty: string; phone: string | null }[] | null
  work_order_line_items?: Array<{
    id: string; work_order_id?: string; line_type: string; description: string
    quantity: number; unit: string | null; unit_cost: number; line_total: number
    sort_order: number; created_at: string
  }>
  work_order_invoices?: { id: string; status: 'pending_payment' | 'paid' | 'cancelled' }
    | { id: string; status: 'pending_payment' | 'paid' | 'cancelled' }[] | null
}

interface PropertyOption {
  id: string
  name: string
  city: string | null
  state: string | null
}

interface VendorOption {
  id: string
  name: string
  specialty: VendorSpecialty
  email: string | null
}

interface CrewMemberOption {
  id: string
  name: string
  role: string
}

interface AssetOption {
  id:          string
  name:        string
  asset_type:  string
  property_id: string
}

interface VendorComplianceRow {
  vendor_id:         string
  compliance_status: ComplianceStatus
}

interface PropertyOptionWithCoords extends PropertyOption {
  lat: number | null
  lng: number | null
}

interface VendorOptionWithCoords extends VendorOption {
  lat: number | null
  lng: number | null
}

interface ScheduleRow {
  id: string
  property_id: string
  org_id: string
  name: string
  description: string | null
  schedule_type: ScheduleType
  frequency: ScheduleFrequency | null
  month_due: number | null
  next_due_date: string | null
  last_completed_date: string | null
  estimated_cost: number | null
  auto_create_wo: boolean
  assigned_vendor_id: string | null
  instructions: string | null
  properties: { name: string } | { name: string }[] | null
  vendors: { id: string; name: string } | { id: string; name: string }[] | null
}

interface TemplateItemRow {
  id:                    string
  name:                  string
  description:           string | null
  schedule_frequency:    ScheduleFrequency
  vendor_specialty_hint: VendorSpecialty | null
  estimated_cost:        number | null
  is_optional_flag:      string | null
  sort_order:            number
}

interface TemplateRow {
  id:          string
  org_id:      string
  name:        string
  description: string | null
  is_system:   boolean
  maintenance_schedule_template_items: TemplateItemRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getJoined<T>(val: T | T[] | null): T | null {
  if (!val) return null
  return Array.isArray(val) ? val[0] ?? null : val
}

function toWorkOrderDetailData(wo: WorkOrderRow): WorkOrderDetailData {
  const prop    = getJoined(wo.properties)
  const vend    = getJoined(wo.vendors)
  const invoice = getJoined(wo.work_order_invoices ?? null)

  return {
    id:                     wo.id,
    wo_number:              wo.wo_number,
    org_id:                 '',
    property_id:            wo.property_id,
    title:                  wo.title,
    description:            wo.description,
    category:               wo.category as WorkOrderDetailData['category'],
    priority:               wo.priority,
    status:                 wo.status,
    source:                 '',
    scheduled_date:         wo.scheduled_date,
    completed_date:         wo.completed_date,
    estimated_cost:         wo.estimated_cost,
    nte_amount:             wo.nte_amount,
    actual_cost:            wo.actual_cost,
    access_notes:           wo.access_notes,
    completion_notes:       wo.completion_notes,
    invoice_reference:      wo.invoice_reference,
    invoiceStatus:          invoice?.status ?? null,
    invoiceId:              invoice?.id ?? null,
    vendor_acknowledged_at: wo.vendor_acknowledged_at,
    completion_verified_at: wo.completion_verified_at,
    created_at:             wo.created_at,
    properties: {
      name:                prop?.name ?? '',
      address:             prop?.address ?? null,
      city:                prop?.city ?? null,
      state:               prop?.state ?? null,
      access_instructions: prop?.access_instructions ?? null,
    },
    vendors: vend ? {
      id:        vend.id,
      name:      vend.name,
      specialty: vend.specialty as WorkOrderDetailData['vendors'] extends { specialty: infer S } | null ? S : never,
      phone:     vend.phone ?? null,
    } : null,
    vendor_dispatch_email: wo.vendor_dispatch_email,
    work_order_line_items: (wo.work_order_line_items ?? []) as WorkOrderDetailData['work_order_line_items'],
  }
}

const KANBAN_COLUMNS: { key: WoStatus; label: string; accentColor: string }[] = [
  { key: 'pending',     label: 'Open',        accentColor: 'var(--text-muted)'   },
  { key: 'assigned',    label: 'Assigned',    accentColor: 'var(--accent-blue)'  },
  { key: 'in_progress', label: 'In Progress', accentColor: '#a78bfa'             },
  { key: 'completed',   label: 'Completed',   accentColor: 'var(--accent-green)' },
]

function priorityBadgeClass(priority: PriorityLevel): string {
  const map: Record<PriorityLevel, string> = {
    low:    'badge badge-slate',
    medium: 'badge badge-blue',
    high:   'badge badge-amber',
    urgent: 'badge badge-red',
  }
  return map[priority]
}

function statusBadgeClass(status: WoStatus): string {
  const map: Record<WoStatus, string> = {
    pending:         'badge badge-slate',
    quote_requested: 'badge badge-gold',
    assigned:        'badge badge-blue',
    in_progress:     'badge badge-amber',
    completed:       'badge badge-green',
    cancelled:       'badge badge-slate',
  }
  return map[status]
}

const PRIORITY_LABELS: Record<PriorityLevel, string> = {
  low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent',
}

const FREQUENCY_LABELS: Partial<Record<ScheduleFrequency, string>> = {
  weekly:      'Weekly',
  biweekly:    'Bi-weekly',
  monthly:     'Monthly',
  quarterly:   'Quarterly',
  semi_annual: 'Semi-annual',
  annual:      'Annual',
}

const SPECIALTY_LABELS: Record<string, string> = {
  plumbing: 'Plumbing', electrical: 'Electrical', hvac: 'HVAC',
  landscaping: 'Landscaping', cleaning: 'Cleaning', pest_control: 'Pest Control',
  pool: 'Pool', roofing: 'Roofing', general: 'General', other: 'Other',
}

const FREQUENCIES: { value: ScheduleFrequency; label: string }[] = [
  { value: 'weekly',      label: 'Weekly'      },
  { value: 'biweekly',   label: 'Bi-weekly'   },
  { value: 'monthly',    label: 'Monthly'      },
  { value: 'quarterly',  label: 'Quarterly'    },
  { value: 'semi_annual', label: 'Semi-annual' },
  { value: 'annual',     label: 'Annual'       },
]

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

const STATUS_TABS = [
  { key: 'all',             label: 'All'           },
  { key: 'pending',         label: 'Pending'       },
  { key: 'quote_requested', label: 'Awaiting Quote' },
  { key: 'assigned',        label: 'Assigned'      },
  { key: 'in_progress',     label: 'In Progress'   },
  { key: 'completed',       label: 'Completed'     },
] as const

// ── Work Order Card ───────────────────────────────────────────────────────────

function WorkOrderCard({
  wo,
  onClick,
  isSelected,
  onToggle,
}: {
  wo: WorkOrderRow
  onClick: () => void
  isSelected: boolean
  onToggle: () => void
}) {
  const property = getJoined(wo.properties)
  const vendor   = getJoined(wo.vendors)

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className={cn(
        'bg-card-themed rounded-xl border border-themed p-4 cursor-pointer',
        'hover:shadow-[0_2px_8px_0_rgba(0,0,0,.08)] hover:border-themed transition-all',
        wo.priority === 'urgent' && 'border-l-4 border-l-red-400',
        wo.priority === 'high'   && 'border-l-4 border-l-amber-400',
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 rounded border-themed text-brand-600 mt-0.5 flex-shrink-0 cursor-pointer"
          aria-label="Select work order"
        />
        <div className="flex-1 min-w-0">
          {/* WO number + title + badges */}
          <div className="flex items-start gap-2 flex-wrap">
            <span className="font-semibold text-primary-themed text-sm leading-snug flex-1 min-w-0 truncate">
              {wo.title}
            </span>
            {wo.wo_number && (
              <span className="font-mono text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                {wo.wo_number}
              </span>
            )}
            <span className={priorityBadgeClass(wo.priority)}>
              {PRIORITY_LABELS[wo.priority]}
            </span>
            <span className={statusBadgeClass(wo.status)}>
              {WO_STATUS_LABELS[wo.status]}
            </span>
          </div>

          {/* Property + vendor */}
          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-themed flex-wrap">
            {property && (
              <span className="flex items-center gap-1">
                <Wrench className="w-3 h-3" />
                {property.name}
              </span>
            )}
            {vendor && (
              <span className="flex items-center gap-1">
                <User className="w-3 h-3" />
                {vendor.name}
              </span>
            )}
            {wo.scheduled_date && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {formatDate(wo.scheduled_date)}
              </span>
            )}
            {(wo.nte_amount != null || wo.estimated_cost != null) && (
              <span className="flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                {(wo.nte_amount ?? wo.estimated_cost ?? 0).toFixed(0)}
                {wo.nte_amount != null && (
                  <span className="text-xs opacity-60">NTE</span>
                )}
              </span>
            )}
          </div>
        </div>

        <ChevronRight className="w-4 h-4 text-muted-themed flex-shrink-0 mt-0.5" />
      </div>
    </div>
  )
}

// ── Create Work Order Modal ───────────────────────────────────────────────────

function CreateWorkOrderModal({
  properties,
  vendors,
  crewMembers = [],
  propertyAssets = [],
  vendorCompliance = [],
  orgId = '',
  onClose,
  onWarning,
}: {
  properties:       PropertyOptionWithCoords[]
  vendors:          VendorOptionWithCoords[]
  crewMembers?:     CrewMemberOption[]
  propertyAssets?:  AssetOption[]
  vendorCompliance?: VendorComplianceRow[]
  orgId?:           string
  onClose:          () => void
  onWarning?:       (msg: string) => void
}) {
  const [state, action, pending]          = useActionState(createWorkOrder, null)
  const [assignMode,         setAssignMode]         = useState<'vendor' | 'crew' | 'quotes'>('vendor')
  const [selectedVendor,     setSelectedVendor]     = useState('')
  const [selectedPropertyId, setSelectedPropertyId] = useState('')
  const [selectedQuoteVendors, setSelectedQuoteVendors] = useState<string[]>([])
  const [photoFiles,         setPhotoFiles]         = useState<File[]>([])
  const photoInputRef = useRef<HTMLInputElement | null>(null)

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId) ?? null
  const assetsForProperty = propertyAssets.filter((a) => a.property_id === selectedPropertyId)

  const complianceFor = (vendorId: string): ComplianceStatus | null =>
    vendorCompliance.find((c) => c.vendor_id === vendorId)?.compliance_status ?? null

  const vendorDistance = (vendorId: string): number | null => {
    if (!selectedProperty?.lat || !selectedProperty?.lng) return null
    const v = vendors.find((vv) => vv.id === vendorId)
    if (!v?.lat || !v?.lng) return null
    return distanceMiles(selectedProperty.lat, selectedProperty.lng, v.lat, v.lng)
  }

  const selectedCompliance = selectedVendor ? complianceFor(selectedVendor) : null

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setPhotoFiles(prev => [...prev, ...files])
    e.target.value = ''
  }

  const removePhoto = (i: number) =>
    setPhotoFiles(prev => prev.filter((_, idx) => idx !== i))

  // After successful WO creation, upload photos
  useEffect(() => {
    if (!state?.success || !state.workOrderId) return

    if (state.warning) onWarning?.(state.warning)

    // No photos attached — close immediately
    if (!photoFiles.length) {
      onClose()
      return
    }

    // Photos to upload — upload then close
    const workOrderId = state.workOrderId
    ;(async () => {
      const supabase = createClient()
      let photoFailures = 0
      for (const file of photoFiles) {
        const ext  = file.name.split('.').pop() ?? 'jpg'
        const path = `wo-${workOrderId}/${Date.now()}-${crypto.randomUUID()}.${ext}`
        const { error: uploadErr } = await supabase.storage
          .from('work-order-photos')
          .upload(path, file, { contentType: file.type })
        if (uploadErr) {
          console.error('[CreateWorkOrderModal] Failed to upload photo:', uploadErr)
          photoFailures++
          continue
        }
        const { error: photoError } = await supabase.from('work_order_photos').insert({
          work_order_id: workOrderId,
          org_id:        orgId,
          storage_path:  path,
        })
        if (photoError) {
          console.error('[CreateWorkOrderModal] Failed to attach photos:', photoError)
          photoFailures++
        }
      }
      // Non-fatal — the WO was created; only photo attachment failed. Surface a
      // non-blocking warning via the existing toast rather than failing the modal.
      if (photoFailures > 0) {
        onWarning?.('Work order created, but some photos could not be attached. You can add them from the work order detail page.')
      }
      onClose()
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.success, state?.workOrderId])

  const toggleQuoteVendor = (id: string) => {
    setSelectedQuoteVendors((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-card-themed rounded-2xl shadow-[0_8px_32px_0_rgba(0,0,0,.16)] w-full max-w-3xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-primary-themed">New Work Order</h3>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {state?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
            {state.error}
          </div>
        )}

        <form action={action} className="space-y-4">
          {/* Hidden fields for mode */}
          <input type="hidden" name="request_quotes" value={assignMode === 'quotes' ? 'true' : 'false'} />
          {assignMode === 'quotes' && selectedQuoteVendors.map((id) => (
            <input key={id} type="hidden" name="quote_vendor_ids" value={id} />
          ))}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left column */}
            <div className="space-y-4">
              {/* Title */}
              <div>
                <label htmlFor="wo-title" className="label">
                  Title <span className="text-red-500">*</span>
                </label>
                <input
                  id="wo-title"
                  name="title"
                  type="text"
                  required
                  className="input"
                  placeholder="e.g. Fix leaking faucet in master bath"
                />
              </div>

              {/* Property */}
              <div>
                <label htmlFor="wo-property" className="label">
                  Property <span className="text-red-500">*</span>
                </label>
                <select
                  id="wo-property"
                  name="property_id"
                  required
                  className="input"
                  value={selectedPropertyId}
                  onChange={(e) => setSelectedPropertyId(e.target.value)}
                >
                  <option value="">Select property…</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              {/* Linked Asset */}
              {assetsForProperty.length > 0 && (
                <div>
                  <label htmlFor="wo-asset" className="label">Linked Asset</label>
                  <select id="wo-asset" name="asset_id" className="input">
                    <option value="">None</option>
                    {assetsForProperty.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} — {a.asset_type.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Description */}
              <div>
                <label htmlFor="wo-desc" className="label">Description</label>
                <textarea
                  id="wo-desc"
                  name="description"
                  rows={4}
                  className="input resize-none"
                  placeholder="Details about the issue or task…"
                />
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-4">
              {/* Priority */}
              <div>
                <label htmlFor="wo-priority" className="label">Priority</label>
                <select id="wo-priority" name="priority" defaultValue="medium" className="input">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>

              {/* Scheduled date + NTE */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="wo-date" className="label">Completed By Date</label>
                  <input id="wo-date" name="scheduled_date" type="date" className="input" />
                </div>
                <div>
                  <label htmlFor="wo-nte" className="label">
                    NTE ($)
                    <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                      ceiling
                    </span>
                  </label>
                  <input
                    id="wo-nte"
                    name="nte_amount"
                    type="number"
                    min="0"
                    step="0.01"
                    className="input"
                    placeholder="0.00"
                  />
                </div>
              </div>

              {/* Assignment mode */}
              <div>
                <label className="label">Assign To</label>
            <div className="flex gap-1 rounded-lg border border-themed p-1 mb-3">
              {vendors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAssignMode('vendor')}
                  className={cn(
                    'flex-1 text-xs font-medium py-1.5 rounded-md transition-colors',
                    assignMode !== 'vendor' && 'text-muted-themed hover:text-secondary-themed'
                  )}
                  style={assignMode === 'vendor' ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
                >
                  Vendor
                </button>
              )}
              {crewMembers.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAssignMode('crew')}
                  className={cn(
                    'flex-1 text-xs font-medium py-1.5 rounded-md transition-colors',
                    assignMode !== 'crew' && 'text-muted-themed hover:text-secondary-themed'
                  )}
                  style={assignMode === 'crew' ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
                >
                  Internal Crew
                </button>
              )}
              {vendors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAssignMode('quotes')}
                  className={cn(
                    'flex-1 text-xs font-medium py-1.5 rounded-md transition-colors',
                    assignMode !== 'quotes' && 'text-muted-themed hover:text-secondary-themed'
                  )}
                  style={assignMode === 'quotes' ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
                >
                  Request quotes
                </button>
              )}
            </div>

          {assignMode === 'crew' ? (
            <select name="assigned_crew_member_id" className="input">
              <option value="">Select crew member…</option>
              {crewMembers.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.role ? ` — ${c.role}` : ''}</option>
              ))}
            </select>
          ) : (
            <>

              {assignMode !== 'quotes' ? (
                <>
                  <select
                    id="wo-vendor"
                    name="vendor_id"
                    className="input"
                    value={selectedVendor}
                    onChange={(e) => setSelectedVendor(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {vendors.map((v) => {
                      const status = complianceFor(v.id)
                      const dist   = vendorDistance(v.id)
                      const blocked = status === 'hard_blocked'
                      const label  = [
                        v.name,
                        dist != null ? `${dist.toFixed(1)} mi` : null,
                        blocked ? '⛔ Blocked' : status === 'expiring_soon' ? '⚠️ Expiring' : null,
                      ].filter(Boolean).join(' · ')
                      return (
                        <option key={v.id} value={v.id} disabled={blocked}>
                          {label}
                        </option>
                      )
                    })}
                  </select>

                  {/* Compliance banner */}
                  {selectedCompliance === 'hard_blocked' && (
                    <div className="text-xs rounded-lg px-3 py-2 mt-2"
                         style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)', border: '1px solid rgba(240,84,84,0.2)' }}>
                      ⛔ This vendor has expired compliance documents (31+ days). Assignment is blocked.
                    </div>
                  )}
                  {selectedCompliance === 'grace_period' && (
                    <div className="text-xs rounded-lg px-3 py-2 mt-2"
                         style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>
                      ⚠️ Compliance docs expired recently (grace period). You can assign but should follow up with the vendor.
                    </div>
                  )}
                  {selectedCompliance === 'expiring_soon' && (
                    <div className="text-xs rounded-lg px-3 py-2 mt-2"
                         style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>
                      ⚠️ COI or license expires soon — assign now but remind vendor to renew.
                    </div>
                  )}
                  {selectedCompliance === 'no_documents' && (
                    <div className="text-xs rounded-lg px-3 py-2 mt-2"
                         style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.2)' }}>
                      ℹ️ No compliance documents on file for this vendor.
                    </div>
                  )}

                  {selectedVendor && selectedCompliance !== 'hard_blocked' && (
                    <label className="flex items-center gap-2 text-sm text-secondary-themed cursor-pointer mt-2">
                      <input
                        type="checkbox"
                        name="portal_enabled"
                        defaultChecked
                        className="w-4 h-4 rounded border-themed text-brand-600 focus:ring-brand-500"
                      />
                      Send vendor portal link (vendor can mark complete via link)
                    </label>
                  )}
                </>
              ) : (
                <div className="border border-themed rounded-xl overflow-hidden">
                  <div className="px-3 py-2 bg-canvas-themed border-b border-themed">
                    <p className="text-xs text-muted-themed">
                      Select vendors to receive an RFQ — you'll be taken to the work order to review and approve quotes.
                    </p>
                  </div>
                  {vendors.map((v) => (
                    <label
                      key={v.id}
                      className="flex items-center gap-3 px-4 py-2.5 border-b border-themed last:border-0 cursor-pointer hover:bg-canvas-themed transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedQuoteVendors.includes(v.id)}
                        onChange={() => toggleQuoteVendor(v.id)}
                        className="w-4 h-4 rounded border-themed text-brand-600 focus:ring-brand-500"
                      />
                      <span className="flex-1 text-sm font-medium text-primary-themed">{v.name}</span>
                      <span className="text-xs text-muted-themed capitalize">{v.specialty.replace('_', ' ')}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
              </div>{/* /Assign To */}
            </div>{/* /right column */}
          </div>{/* /two-col grid */}

          {/* Photo attachments */}
          <div>
            <label className="label">Photos (optional)</label>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handlePhotoSelect}
            />
            <div className="flex flex-wrap gap-2">
              {photoFiles.map((file, i) => (
                <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-themed">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={URL.createObjectURL(file)} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removePhoto(i)}
                    className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 rounded-full flex items-center justify-center"
                  >
                    <X className="w-2.5 h-2.5 text-white" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="w-16 h-16 rounded-lg border-2 border-dashed border-themed flex items-center justify-center transition-colors hover:border-brand-400"
                style={{ color: 'var(--text-muted)' }}
              >
                <Camera className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex gap-3 pt-2 border-t border-themed">
            <button
              type="submit"
              disabled={pending || selectedCompliance === 'hard_blocked'}
              className="btn-primary flex-1"
            >
              {pending
                ? 'Creating…'
                : assignMode === 'quotes' && selectedQuoteVendors.length > 0
                ? `Create & Request ${selectedQuoteVendors.length} Quote${selectedQuoteVendors.length !== 1 ? 's' : ''}`
                : 'Create Work Order'}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Schedule Form Fields (shared by Add + Edit) ───────────────────────────────

function ScheduleFormFields({
  properties,
  vendors,
  defaults,
}: {
  properties: PropertyOption[]
  vendors: VendorOption[]
  defaults?: Partial<ScheduleRow>
}) {
  const [schedType, setSchedType] = useState<ScheduleType>(defaults?.schedule_type ?? 'routine')

  return (
    <>
      <div>
        <label className="label">Name <span className="text-red-500">*</span></label>
        <input name="name" type="text" required className="input" defaultValue={defaults?.name ?? ''} placeholder="e.g. HVAC Filter Change" />
      </div>

      {!defaults && (
        <div>
          <label className="label">Property <span className="text-red-500">*</span></label>
          <select name="property_id" required className="input">
            <option value="">Select property…</option>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="label">Type</label>
        <select
          name="schedule_type"
          className="input"
          value={schedType}
          onChange={(e) => setSchedType(e.target.value as ScheduleType)}
        >
          <option value="routine">Routine (recurring)</option>
          <option value="seasonal">Seasonal (specific month)</option>
          <option value="one_time">One-time</option>
        </select>
      </div>

      {schedType === 'routine' && (
        <div>
          <label className="label">Frequency</label>
          <select name="frequency" className="input" defaultValue={defaults?.frequency ?? 'quarterly'}>
            {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
      )}

      {schedType === 'seasonal' && (
        <div>
          <label className="label">Month Due</label>
          <select name="month_due" className="input" defaultValue={defaults?.month_due ?? ''}>
            <option value="">Select month…</option>
            {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
          </select>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">Next Due Date</label>
          <input name="next_due_date" type="date" className="input" defaultValue={defaults?.next_due_date ?? ''} />
        </div>
        <div>
          <label className="label">Est. Cost ($)</label>
          <input name="estimated_cost" type="number" min="0" step="0.01" className="input" defaultValue={defaults?.estimated_cost ?? ''} placeholder="0.00" />
        </div>
      </div>

      <div>
        <label className="label">Assigned Vendor</label>
        <select name="assigned_vendor_id" className="input" defaultValue={defaults?.assigned_vendor_id ?? ''}>
          <option value="">None</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </div>

      <div>
        <label className="label">Description</label>
        <textarea name="description" rows={2} className="input resize-none" defaultValue={defaults?.description ?? ''} placeholder="Brief description…" />
      </div>

      <div>
        <label className="label">Instructions</label>
        <textarea name="instructions" rows={2} className="input resize-none" defaultValue={defaults?.instructions ?? ''} placeholder="Step-by-step instructions for vendor or crew…" />
      </div>

      <label className="flex items-center gap-2 text-sm text-secondary-themed cursor-pointer">
        <input type="checkbox" name="auto_create_wo" defaultChecked={defaults?.auto_create_wo ?? true} className="w-4 h-4 rounded" />
        Auto-create work order when due
      </label>
    </>
  )
}

// ── Add Schedule Modal ────────────────────────────────────────────────────────

function AddScheduleModal({
  properties,
  vendors,
  onClose,
}: {
  properties: PropertyOption[]
  vendors: VendorOption[]
  onClose: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const fd = new FormData(e.currentTarget)
    const result = await createMaintenanceSchedule({
      property_id:        fd.get('property_id') as string,
      name:               fd.get('name') as string,
      description:        (fd.get('description') as string) || null,
      schedule_type:      (fd.get('schedule_type') as ScheduleType) || 'routine',
      frequency:          (fd.get('frequency') as ScheduleFrequency) || null,
      month_due:          fd.get('month_due') ? Number(fd.get('month_due')) : null,
      next_due_date:      (fd.get('next_due_date') as string) || null,
      estimated_cost:     fd.get('estimated_cost') ? parseFloat(fd.get('estimated_cost') as string) : null,
      assigned_vendor_id: (fd.get('assigned_vendor_id') as string) || null,
      auto_create_wo:     fd.get('auto_create_wo') === 'on',
      instructions:       (fd.get('instructions') as string) || null,
    })
    setSaving(false)
    if (result.error) { setError(result.error); return }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-card-themed rounded-2xl shadow-[0_8px_32px_0_rgba(0,0,0,.16)] w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-primary-themed">Add Maintenance Schedule</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <ScheduleFormFields properties={properties} vendors={vendors} />
          <div className="flex gap-3 pt-2 border-t border-themed">
            <button type="submit" disabled={saving} className="btn-primary flex-1">{saving ? 'Saving…' : 'Add Schedule'}</button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Edit Schedule Modal ───────────────────────────────────────────────────────

function EditScheduleModal({
  schedule,
  vendors,
  onClose,
}: {
  schedule: ScheduleRow
  vendors: VendorOption[]
  onClose: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const fd = new FormData(e.currentTarget)
    const result = await updateMaintenanceSchedule(schedule.id, {
      name:               fd.get('name') as string,
      description:        (fd.get('description') as string) || null,
      schedule_type:      (fd.get('schedule_type') as ScheduleType) || 'routine',
      frequency:          (fd.get('frequency') as ScheduleFrequency) || null,
      month_due:          fd.get('month_due') ? Number(fd.get('month_due')) : null,
      next_due_date:      (fd.get('next_due_date') as string) || null,
      estimated_cost:     fd.get('estimated_cost') ? parseFloat(fd.get('estimated_cost') as string) : null,
      assigned_vendor_id: (fd.get('assigned_vendor_id') as string) || null,
      auto_create_wo:     fd.get('auto_create_wo') === 'on',
      instructions:       (fd.get('instructions') as string) || null,
    })
    setSaving(false)
    if (result.error) { setError(result.error); return }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-card-themed rounded-2xl shadow-[0_8px_32px_0_rgba(0,0,0,.16)] w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-primary-themed">Edit Schedule</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <ScheduleFormFields properties={[]} vendors={vendors} defaults={schedule} />
          <div className="flex gap-3 pt-2 border-t border-themed">
            <button type="submit" disabled={saving} className="btn-primary flex-1">{saving ? 'Saving…' : 'Save Changes'}</button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Schedules Section ─────────────────────────────────────────────────────────

function SchedulesSection({
  schedules,
  properties,
  vendors,
}: {
  schedules: ScheduleRow[]
  properties: PropertyOption[]
  vendors: VendorOption[]
}) {
  const [open, setOpen]             = useState(false)
  const [showAdd, setShowAdd]       = useState(false)
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [creating, startCreate]     = useTransition()
  const [deleting, startDelete]     = useTransition()
  const [creatingId, setCreatingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleCreateWO = (scheduleId: string) => {
    setCreatingId(scheduleId)
    startCreate(async () => {
      await createWorkOrderFromSchedule(scheduleId)
      setCreatingId(null)
    })
  }

  const handleDelete = (scheduleId: string) => {
    if (!confirm('Remove this schedule? This cannot be undone.')) return
    setDeletingId(scheduleId)
    setDeleteError(null)
    startDelete(async () => {
      const result = await deleteMaintenanceSchedule(scheduleId)
      setDeletingId(null)
      if (result?.error) {
        setDeleteError('Could not delete this schedule. Please try again.')
      }
    })
  }

  const editingSchedule = schedules.find((s) => s.id === editingId) ?? null

  return (
    <>
      <div className="mt-8">
        <div className="flex items-center gap-2 mb-1">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-2 flex-1 text-left group"
          >
            <span className="text-sm font-semibold text-secondary-themed group-hover:text-primary-themed transition-colors">
              Maintenance Schedules
            </span>
            <span className="badge badge-slate">{schedules.length}</span>
            <ChevronDown className={cn('w-4 h-4 text-muted-themed ml-auto transition-transform', open && 'rotate-180')} />
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            Add Schedule
          </button>
        </div>
        <p className="text-xs text-muted-themed mb-3">Recurring tasks that generate work orders automatically</p>

        {deleteError && (
          <div
            className="mb-3 px-4 py-3 rounded-xl text-sm"
            style={{
              backgroundColor: 'var(--accent-red-dim)',
              color:           'var(--accent-red)',
              border:          '1px solid rgba(240,84,84,0.2)',
            }}
          >
            {deleteError}
            <button
              onClick={() => setDeleteError(null)}
              className="ml-2 underline text-xs"
            >
              Dismiss
            </button>
          </div>
        )}

        {open && schedules.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-themed border border-themed rounded-xl">
            No schedules yet. Click "Add Schedule" to create one.
          </div>
        )}

        {open && schedules.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-themed bg-card-themed">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-themed bg-canvas-themed">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Property</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Frequency</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Next Due</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Last Done</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-themed uppercase tracking-wide">Auto</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-themed">
                {schedules.map((s) => {
                  const property  = getJoined(s.properties)
                  const isOverdue = s.next_due_date && new Date(s.next_due_date) < new Date()
                  return (
                    <tr key={s.id} className="hover:bg-canvas-themed transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-medium text-primary-themed">{s.name}</span>
                        {s.description && (
                          <p className="text-xs text-muted-themed mt-0.5 truncate max-w-[200px]">{s.description}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-secondary-themed">{property?.name ?? '—'}</td>
                      <td className="px-4 py-3 text-secondary-themed">
                        {s.schedule_type === 'seasonal' && s.month_due
                          ? MONTHS[(s.month_due - 1) % 12]
                          : s.frequency ? FREQUENCY_LABELS[s.frequency] ?? s.frequency : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {s.next_due_date ? (
                          <span className={cn('flex items-center gap-1', isOverdue ? 'text-red-600 font-medium' : 'text-secondary-themed')}>
                            {isOverdue && <AlertTriangle className="w-3 h-3" />}
                            {formatDate(s.next_due_date)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-secondary-themed">
                        {s.last_completed_date ? (
                          <span className="flex items-center gap-1 text-green-600">
                            <CheckCircle2 className="w-3 h-3" />
                            {formatDate(s.last_completed_date)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {s.auto_create_wo ? (
                          <span className="badge badge-green">Auto</span>
                        ) : (
                          <span className="badge badge-slate">Manual</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleCreateWO(s.id)}
                            disabled={creating && creatingId === s.id}
                            className="btn-secondary text-xs py-1.5 px-3 whitespace-nowrap"
                          >
                            {creating && creatingId === s.id ? <Clock className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                            Create WO
                          </button>
                          <button
                            onClick={() => setEditingId(s.id)}
                            className="btn-ghost p-1.5"
                            title="Edit schedule"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(s.id)}
                            disabled={deleting && deletingId === s.id}
                            className="btn-ghost p-1.5 text-red-500 hover:text-red-600"
                            title="Delete schedule"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAdd && (
        <AddScheduleModal
          properties={properties}
          vendors={vendors}
          onClose={() => setShowAdd(false)}
        />
      )}

      {editingSchedule && (
        <EditScheduleModal
          schedule={editingSchedule}
          vendors={vendors}
          onClose={() => setEditingId(null)}
        />
      )}
    </>
  )
}

// ── Template Broadcast Modal ──────────────────────────────────────────────────

function TemplateBroadcastModal({
  template,
  properties,
  onClose,
}: {
  template: TemplateRow
  properties: PropertyOption[]
  onClose: () => void
}) {
  const [step, setStep]                       = useState<1 | 2 | 3>(1)
  const [selectedPropertyIds, setSelectedIds] = useState<string[]>([])
  const [broadcasting, setBroadcasting]       = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [result, setResult]                   = useState<BroadcastResult | null>(null)

  const items        = template.maintenance_schedule_template_items
  const allSelected  = properties.length > 0 && selectedPropertyIds.length === properties.length
  const totalItems   = items.length * selectedPropertyIds.length

  const toggleProperty = (id: string) => {
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])
  }

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : properties.map((p) => p.id))
  }

  const handleBroadcast = async () => {
    setBroadcasting(true)
    setError(null)
    const res = await broadcastMaintenanceTemplate(template.id, selectedPropertyIds)
    setBroadcasting(false)
    if (res.error) { setError(res.error); return }
    setResult(res)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-card-themed rounded-2xl shadow-[0_8px_32px_0_rgba(0,0,0,.16)] w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-lg font-semibold text-primary-themed">Broadcast Template</h3>
            <p className="text-xs text-muted-themed mt-0.5">{template.name} · {items.length} item{items.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        {!result && (
          <div className="flex items-center gap-2 mb-5">
            {[1, 2, 3].map((n) => (
              <div key={n} className="flex items-center gap-2 flex-1">
                <div
                  className={cn(
                    'w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0',
                    step === n ? '' : step > n ? 'bg-green-100 text-green-700' : 'bg-raised-themed text-muted-themed'
                  )}
                  style={step === n ? { background: 'var(--accent-gold)', color: 'var(--bg-base)' } : undefined}
                >
                  {step > n ? <CheckCircle2 className="w-3.5 h-3.5" /> : n}
                </div>
                {n < 3 && <div className={cn('h-0.5 flex-1', step > n ? 'bg-green-300' : 'bg-themed')} />}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">{error}</div>
        )}

        {result ? (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
              <p className="font-medium">Broadcast complete</p>
              <p className="mt-1">
                Created {result.created} schedule{result.created !== 1 ? 's' : ''} across{' '}
                {selectedPropertyIds.length} propert{selectedPropertyIds.length !== 1 ? 'ies' : 'y'}.
              </p>
              {(result.skipped ?? 0) > 0 && (
                <p className="mt-1 text-green-600">
                  {result.skipped} item{result.skipped !== 1 ? 's' : ''} skipped — already existed by name.
                </p>
              )}
            </div>
            <button onClick={onClose} className="btn-primary w-full">Done</button>
          </div>
        ) : (
          <>
            {step === 1 && (
              <div>
                <p className="text-sm font-medium text-secondary-themed mb-3">This template includes:</p>
                <ul className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                  {items.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2 text-sm bg-canvas-themed rounded-lg px-3 py-2">
                      <span className="text-secondary-themed truncate">{item.name}</span>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {item.is_optional_flag && (
                          <span className="badge badge-amber text-xs">⚠️ {item.is_optional_flag}</span>
                        )}
                        <span className="badge badge-slate text-xs">
                          {FREQUENCY_LABELS[item.schedule_frequency] ?? item.schedule_frequency}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-3 pt-4 mt-2 border-t border-themed">
                  <button onClick={() => setStep(2)} className="btn-primary flex-1">Continue</button>
                  <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-medium text-secondary-themed">Select properties</p>
                  <button onClick={toggleAll} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                  {properties.map((p) => (
                    <label key={p.id} className="flex items-center gap-2.5 text-sm bg-canvas-themed rounded-lg px-3 py-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedPropertyIds.includes(p.id)}
                        onChange={() => toggleProperty(p.id)}
                        className="w-4 h-4 rounded"
                      />
                      <span className="text-secondary-themed">{p.name}</span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-3 pt-4 mt-2 border-t border-themed">
                  <button onClick={() => setStep(1)} className="btn-ghost">Back</button>
                  <button
                    onClick={() => setStep(3)}
                    disabled={selectedPropertyIds.length === 0}
                    className="btn-primary flex-1"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div>
                <div className="bg-canvas-themed border border-themed rounded-lg px-4 py-3 text-sm text-secondary-themed mb-4">
                  <p>
                    Broadcasting <span className="font-semibold text-primary-themed">{items.length}</span> schedule
                    {items.length !== 1 ? 's' : ''} to <span className="font-semibold text-primary-themed">{selectedPropertyIds.length}</span> propert
                    {selectedPropertyIds.length !== 1 ? 'ies' : 'y'} = up to{' '}
                    <span className="font-semibold text-primary-themed">{totalItems}</span> schedule items.
                  </p>
                  <p className="mt-1.5 text-xs text-muted-themed">
                    Items that already exist by name on a property will be skipped — safe to re-run.
                  </p>
                </div>
                <div className="flex gap-3 pt-2 border-t border-themed">
                  <button onClick={() => setStep(2)} disabled={broadcasting} className="btn-ghost">Back</button>
                  <button
                    onClick={handleBroadcast}
                    disabled={broadcasting}
                    className="btn-primary flex-1 flex items-center justify-center gap-2"
                  >
                    {broadcasting ? <Clock className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    {broadcasting ? 'Broadcasting…' : 'Broadcast'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Create Template Modal ─────────────────────────────────────────────────────

interface NewTemplateItem {
  name:                  string
  description:           string
  schedule_frequency:    ScheduleFrequency
  vendor_specialty_hint: VendorSpecialty | ''
  estimated_cost:        string
  catalogId?:            string
}

const EMPTY_TEMPLATE_ITEM: NewTemplateItem = {
  name: '', description: '', schedule_frequency: 'quarterly', vendor_specialty_hint: '', estimated_cost: '',
}

function CreateTemplateModal({
  onClose,
  catalogItems,
  properties,
}: {
  onClose: () => void
  catalogItems: TemplateItemRow[]
  properties: PropertyOption[]
}) {
  const [name, setName]           = useState('')
  const [description, setDesc]    = useState('')
  const [items, setItems]         = useState<NewTemplateItem[]>([{ ...EMPTY_TEMPLATE_ITEM }])
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [showCatalog, setShowCatalog] = useState(catalogItems.length > 0)

  // Post-creation "apply to properties" step
  const [createdTemplateId, setCreatedTemplateId]     = useState<string | null>(null)
  const [createdTemplateName, setCreatedTemplateName] = useState('')
  const [applyMode, setApplyMode]                     = useState<'all' | 'select'>('all')
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<string[]>([])
  const [applying, setApplying]                       = useState(false)
  const [applyError, setApplyError]                   = useState<string | null>(null)
  const [applyResult, setApplyResult]                 = useState<BroadcastResult | null>(null)

  const addItem = () =>
    setItems((prev) => [...prev, { ...EMPTY_TEMPLATE_ITEM }])

  const removeItem = (i: number) =>
    setItems((prev) => prev.filter((_, idx) => idx !== i))

  const updateItem = (i: number, field: keyof NewTemplateItem, value: string) =>
    setItems((prev) => prev.map((item, idx) => idx === i ? { ...item, [field]: value } : item))

  const isCatalogSelected = (catalogId: string) => items.some((it) => it.catalogId === catalogId)

  const catalogItemToTemplateItem = (ci: TemplateItemRow): NewTemplateItem => ({
    name:                  ci.name,
    description:           ci.description ?? '',
    schedule_frequency:    ci.schedule_frequency,
    vendor_specialty_hint: (ci.vendor_specialty_hint ?? '') as VendorSpecialty | '',
    estimated_cost:        ci.estimated_cost != null ? String(ci.estimated_cost) : '',
    catalogId:             ci.id,
  })

  const toggleCatalogItem = (ci: TemplateItemRow) => {
    setItems((prev) => {
      if (prev.some((it) => it.catalogId === ci.id)) {
        const next = prev.filter((it) => it.catalogId !== ci.id)
        return next.length ? next : [{ ...EMPTY_TEMPLATE_ITEM }]
      }
      const withoutEmpty = prev.filter((it) => it.name.trim() || it.catalogId)
      return [...withoutEmpty, catalogItemToTemplateItem(ci)]
    })
  }

  const catalogGroups = useMemo(() => {
    const groups: Record<string, TemplateItemRow[]> = {}
    for (const ci of catalogItems) {
      const key = ci.vendor_specialty_hint ?? 'general'
      if (!groups[key]) groups[key] = []
      groups[key].push(ci)
    }
    return groups
  }, [catalogItems])

  const catalogGroupKeys = useMemo(() => Object.keys(catalogGroups).sort((a, b) => {
    if (a === 'general') return 1
    if (b === 'general') return -1
    return (SPECIALTY_LABELS[a] ?? a).localeCompare(SPECIALTY_LABELS[b] ?? b)
  }), [catalogGroups])

  const allCatalogSelected = catalogItems.length > 0 && catalogItems.every((ci) => isCatalogSelected(ci.id))

  const toggleAllCatalog = () => {
    if (allCatalogSelected) {
      setItems((prev) => {
        const next = prev.filter((it) => !it.catalogId)
        return next.length ? next : [{ ...EMPTY_TEMPLATE_ITEM }]
      })
    } else {
      setItems((prev) => {
        const withoutEmpty = prev.filter((it) => it.name.trim() || it.catalogId)
        const existing = new Set(withoutEmpty.filter((it) => it.catalogId).map((it) => it.catalogId))
        const toAdd = catalogItems.filter((ci) => !existing.has(ci.id)).map(catalogItemToTemplateItem)
        return [...withoutEmpty, ...toAdd]
      })
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setError('Template name is required'); return }
    const validItems = items.filter((it) => it.name.trim())
    if (!validItems.length) { setError('Add at least one item'); return }
    setSaving(true)
    setError(null)
    const result = await createMaintenanceScheduleTemplate({
      name:        name.trim(),
      description: description.trim() || null,
      items:       validItems.map((it, i) => ({
        name:                  it.name.trim(),
        description:           it.description.trim() || null,
        schedule_frequency:    it.schedule_frequency,
        vendor_specialty_hint: (it.vendor_specialty_hint as VendorSpecialty | null) || null,
        estimated_cost:        it.estimated_cost ? parseFloat(it.estimated_cost) : null,
        sort_order:            i,
      })),
    })
    setSaving(false)
    if (result.error) { setError(result.error); return }
    if (result.templateId) {
      setCreatedTemplateName(name.trim())
      setCreatedTemplateId(result.templateId)
    } else {
      onClose()
    }
  }

  // Property selection for the post-creation "apply" step
  const allPropertiesSelected = properties.length > 0 && selectedPropertyIds.length === properties.length

  const toggleProperty = (id: string) =>
    setSelectedPropertyIds((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])

  const toggleAllProperties = () =>
    setSelectedPropertyIds(allPropertiesSelected ? [] : properties.map((p) => p.id))

  const handleApply = async () => {
    if (!createdTemplateId) return
    const propertyIds = applyMode === 'all' ? properties.map((p) => p.id) : selectedPropertyIds
    if (propertyIds.length === 0) { setApplyError('Select at least one property'); return }
    setApplying(true)
    setApplyError(null)
    const res = await broadcastMaintenanceTemplate(createdTemplateId, propertyIds)
    setApplying(false)
    if (res.error) { setApplyError(res.error); return }
    setApplyResult(res)
  }

  if (createdTemplateId) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
        <div className="bg-card-themed rounded-2xl shadow-[0_8px_32px_0_rgba(0,0,0,.16)] w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="text-lg font-semibold text-primary-themed">Apply Template</h3>
              <p className="text-xs text-muted-themed mt-0.5">"{createdTemplateName}" was created</p>
            </div>
            <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
          </div>

          {applyError && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">{applyError}</div>
          )}

          {applyResult ? (
            <div className="space-y-4">
              <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Template applied</p>
                  <p className="mt-1">
                    Created {applyResult.created} schedule{applyResult.created !== 1 ? 's' : ''}
                    {(applyResult.skipped ?? 0) > 0 && <> · {applyResult.skipped} skipped (already existed)</>}
                  </p>
                </div>
              </div>
              <button onClick={onClose} className="btn-primary w-full">Done</button>
            </div>
          ) : properties.length === 0 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-themed">No properties found to apply this template to. You can broadcast it later from the Schedule Templates list.</p>
              <button onClick={onClose} className="btn-primary w-full">Done</button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-secondary-themed">Apply this template's schedules now?</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setApplyMode('all')}
                  className={cn(
                    'flex-1 text-sm rounded-lg px-3 py-2 border text-center',
                    applyMode === 'all' ? 'font-medium' : 'border-themed text-secondary-themed'
                  )}
                  style={applyMode === 'all' ? { background: 'var(--accent-gold-dim)', borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
                >
                  All properties ({properties.length})
                </button>
                <button
                  type="button"
                  onClick={() => setApplyMode('select')}
                  className={cn(
                    'flex-1 text-sm rounded-lg px-3 py-2 border text-center',
                    applyMode === 'select' ? 'font-medium' : 'border-themed text-secondary-themed'
                  )}
                  style={applyMode === 'select' ? { borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' } : undefined}
                >
                  Select properties
                </button>
              </div>

              {applyMode === 'select' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-secondary-themed">Properties</p>
                    <button type="button" onClick={toggleAllProperties} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
                      {allPropertiesSelected ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                    {properties.map((p) => (
                      <label key={p.id} className="flex items-center gap-2.5 text-sm bg-canvas-themed rounded-lg px-3 py-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedPropertyIds.includes(p.id)}
                          onChange={() => toggleProperty(p.id)}
                          className="w-4 h-4 rounded"
                        />
                        <span className="text-secondary-themed">{p.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-4 mt-2 border-t border-themed">
                <button type="button" onClick={onClose} className="btn-ghost">Skip</button>
                <button
                  onClick={handleApply}
                  disabled={applying || (applyMode === 'select' && selectedPropertyIds.length === 0)}
                  className="btn-primary flex-1 flex items-center justify-center gap-2"
                >
                  {applying ? <Clock className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {applying ? 'Applying…' : 'Apply Template'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-card-themed rounded-2xl shadow-[0_8px_32px_0_rgba(0,0,0,.16)] w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-primary-themed">Create Schedule Template</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Template Name <span className="text-red-500">*</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="e.g. STR Annual Maintenance" required />
          </div>
          <div>
            <label className="label">Description</label>
            <input value={description} onChange={(e) => setDesc(e.target.value)} className="input" placeholder="Optional description…" />
          </div>

          {catalogItems.length > 0 && (
            <div className="border border-themed rounded-xl bg-canvas-themed">
              <button
                type="button"
                onClick={() => setShowCatalog((s) => !s)}
                className="flex items-center justify-between w-full text-left p-3"
              >
                <span className="text-sm font-medium text-secondary-themed">
                  Add from Catalog <span className="text-muted-themed font-normal">({catalogItems.length} seeded items)</span>
                </span>
                <ChevronDown className={cn('w-4 h-4 text-muted-themed transition-transform flex-shrink-0', showCatalog && 'rotate-180')} />
              </button>
              {showCatalog && (
                <div className="px-3 pb-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-themed">Select items to include in this template</p>
                    <button type="button" onClick={toggleAllCatalog} className="text-xs font-medium" style={{ color: 'var(--accent-gold)' }}>
                      {allCatalogSelected ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto pr-1 space-y-3">
                    {catalogGroupKeys.map((key) => (
                      <div key={key}>
                        <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-1">
                          {SPECIALTY_LABELS[key] ?? key}
                        </p>
                        <div className="space-y-1">
                          {catalogGroups[key].map((ci) => (
                            <label key={ci.id} className="flex items-center gap-2.5 text-sm bg-card-themed rounded-lg px-3 py-1.5 cursor-pointer border border-themed">
                              <input
                                type="checkbox"
                                checked={isCatalogSelected(ci.id)}
                                onChange={() => toggleCatalogItem(ci)}
                                className="w-4 h-4 rounded flex-shrink-0"
                              />
                              <span className="text-secondary-themed flex-1 truncate">{ci.name}</span>
                              {ci.is_optional_flag && (
                                <span className="badge badge-amber text-xs flex-shrink-0">⚠️ {ci.is_optional_flag}</span>
                              )}
                              <span className="badge badge-slate text-xs flex-shrink-0">
                                {FREQUENCY_LABELS[ci.schedule_frequency] ?? ci.schedule_frequency}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">Items <span className="text-red-500">*</span></label>
              <button type="button" onClick={addItem} className="btn-secondary text-xs py-1 px-2 flex items-center gap-1">
                <Plus className="w-3 h-3" /> Add Item
              </button>
            </div>
            <div className="space-y-2">
              {items.map((item, i) => (
                <div key={i} className="border border-themed rounded-xl p-3 space-y-2 bg-canvas-themed">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="label text-xs">Item Name <span className="text-red-500">*</span></label>
                        <input value={item.name} onChange={(e) => updateItem(i, 'name', e.target.value)}
                               className="input text-sm" placeholder="e.g. HVAC Filter Replacement" />
                      </div>
                      <div>
                        <label className="label text-xs">Frequency</label>
                        <select value={item.schedule_frequency}
                                onChange={(e) => updateItem(i, 'schedule_frequency', e.target.value)}
                                className="input text-sm">
                          {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="label text-xs">Vendor Specialty</label>
                        <select value={item.vendor_specialty_hint}
                                onChange={(e) => updateItem(i, 'vendor_specialty_hint', e.target.value)}
                                className="input text-sm">
                          <option value="">None</option>
                          {Object.entries(SPECIALTY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="label text-xs">Est. Cost ($)</label>
                        <input type="number" min="0" step="0.01" value={item.estimated_cost}
                               onChange={(e) => updateItem(i, 'estimated_cost', e.target.value)}
                               className="input text-sm" placeholder="0.00" />
                      </div>
                    </div>
                    {items.length > 1 && (
                      <button type="button" onClick={() => removeItem(i)}
                              className="btn-ghost p-1.5 text-red-500 hover:text-red-600 mt-5 flex-shrink-0">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-2 border-t border-themed">
            <button type="submit" disabled={saving} className="btn-primary flex-1">
              {saving ? 'Creating…' : 'Create Template'}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Templates Section ─────────────────────────────────────────────────────────

function TemplatesSection({
  templates,
  properties,
}: {
  templates: TemplateRow[]
  properties: PropertyOption[]
}) {
  const [open, setOpen]                             = useState(false)
  const [broadcastTemplateId, setBroadcastTemplateId] = useState<string | null>(null)
  const [showCreateTemplate, setShowCreateTemplate] = useState(false)
  const [editTemplateId, setEditTemplateId]         = useState<string | null>(null)

  const broadcastTemplate = templates.find((t) => t.id === broadcastTemplateId) ?? null
  const editTemplate = templates.find((t) => t.id === editTemplateId) ?? null
  const catalogItems = templates.find((t) => t.is_system)?.maintenance_schedule_template_items ?? []

  return (
    <>
      <div className="mt-8">
        <div className="flex items-center gap-2 mb-1">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-2 flex-1 text-left group"
          >
            <span className="text-sm font-semibold text-secondary-themed group-hover:text-primary-themed transition-colors">
              Schedule Templates
            </span>
            <span className="badge badge-slate">{templates.length}</span>
            <ChevronDown className={cn('w-4 h-4 text-muted-themed ml-auto transition-transform', open && 'rotate-180')} />
          </button>
          <button
            onClick={() => setShowCreateTemplate(true)}
            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            Create Template
          </button>
        </div>
        <p className="text-xs text-muted-themed mb-3">
          Broadcast a curated set of recurring maintenance schedules to multiple properties at once
        </p>

        {open && templates.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-themed border border-themed rounded-xl">
            No templates yet. Click "Create Template" to build one.
          </div>
        )}

        {open && templates.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {templates.map((t) => {
              const items   = t.maintenance_schedule_template_items
              const preview = items.slice(0, 4)
              return (
                <div key={t.id} className="bg-card-themed rounded-xl border border-themed p-4 flex flex-col">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="font-medium text-primary-themed text-sm">{t.name}</span>
                    {t.is_system && (
                      <span
                        className="badge badge-blue flex-shrink-0"
                        title="This is a read-only FieldStay template. Create your own template to customise it."
                      >
                        FieldStay · Read-only
                      </span>
                    )}
                  </div>
                  {t.description && (
                    <p className="text-xs text-muted-themed mb-2 truncate">{t.description}</p>
                  )}
                  <span className="badge badge-slate w-fit mb-2">{items.length} item{items.length !== 1 ? 's' : ''}</span>
                  <ul className="text-xs text-secondary-themed space-y-0.5 mb-3 flex-1">
                    {preview.map((item) => (
                      <li key={item.id} className="truncate">• {item.name}</li>
                    ))}
                    {items.length > preview.length && (
                      <li className="text-muted-themed">+ {items.length - preview.length} more…</li>
                    )}
                  </ul>
                  <div className="flex gap-2 mt-auto">
                    {!t.is_system && (
                      <Link
                        href={`/setup/maintenance-template?edit=${t.id}`}
                        className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1 flex-shrink-0"
                      >
                        <Pencil className="w-3 h-3" />
                        Edit
                      </Link>
                    )}
                    <button
                      onClick={() => setBroadcastTemplateId(t.id)}
                      disabled={properties.length === 0}
                      className="btn-secondary text-xs py-1.5 px-3 flex items-center justify-center gap-1.5 flex-1"
                    >
                      <Send className="w-3 h-3" />
                      Broadcast
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {broadcastTemplate && (
        <TemplateBroadcastModal
          template={broadcastTemplate}
          properties={properties}
          onClose={() => setBroadcastTemplateId(null)}
        />
      )}

      {editTemplate && !editTemplate.is_system && (
        <EditTemplateModal
          template={editTemplate}
          onClose={() => setEditTemplateId(null)}
        />
      )}

      {showCreateTemplate && (
        <CreateTemplateModal
          onClose={() => setShowCreateTemplate(false)}
          catalogItems={catalogItems}
          properties={properties}
        />
      )}
    </>
  )
}

// ── Edit Template Modal ───────────────────────────────────────────────────────

function EditTemplateModal({
  template,
  onClose,
}: {
  template: TemplateRow
  onClose:  () => void
}) {
  const [name,        setName]        = useState(template.name)
  const [description, setDescription] = useState(template.description ?? '')
  const [saving,      startSave]      = useTransition()
  const [error,       setError]       = useState<string | null>(null)
  const [success,     setSuccess]     = useState(false)

  const handleSave = () => {
    const trimmedName = name.trim()
    if (!trimmedName) { setError('Name is required'); return }
    if (trimmedName.length > 100) { setError('Name must be 100 characters or fewer'); return }

    setError(null)
    startSave(async () => {
      const result = await updateMaintenanceTemplate(template.id, {
        name:        trimmedName,
        description: description.trim() || null,
      })
      if (result?.error) setError(result.error)
      else               setSuccess(true)
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div
        className="rounded-2xl shadow-card-lg w-full max-w-md p-6"
        style={{ background: 'var(--bg-card)' }}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-primary-themed">Edit Template</h3>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {success ? (
          <div className="text-center py-4">
            <p className="text-sm font-medium mb-4" style={{ color: 'var(--accent-green)' }}>
              ✓ Template updated
            </p>
            <button onClick={onClose} className="btn-primary">Done</button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="label">Template Name <span className="text-red-400">*</span></label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                className="input w-full"
                placeholder="e.g. Seasonal Rental Prep"
              />
            </div>
            <div>
              <label className="label">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                rows={3}
                className="input w-full resize-none"
                placeholder="Optional — shown on the template card"
              />
            </div>

            {error && (
              <p className="text-sm" style={{ color: 'var(--accent-red)' }}>{error}</p>
            )}

            <div className="flex gap-3 pt-1">
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary flex-1 flex items-center justify-center gap-2"
              >
                {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save Changes'}
              </button>
              <button onClick={onClose} className="btn-ghost">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Board ────────────────────────────────────────────────────────────────

export function MaintenanceBoard({
  workOrders,
  properties,
  vendors,
  schedules,
  templates = [],
  crewMembers = [],
  propertyAssets = [],
  vendorCompliance = [],
  orgId = '',
  role,
}: {
  workOrders:       WorkOrderRow[]
  properties:       PropertyOptionWithCoords[]
  vendors:          VendorOptionWithCoords[]
  schedules:        ScheduleRow[]
  templates?:       TemplateRow[]
  crewMembers?:     CrewMemberOption[]
  propertyAssets?:  AssetOption[]
  vendorCompliance?: VendorComplianceRow[]
  orgId?:           string
  role:             string
}) {
  const searchParams  = useSearchParams()
  const urlFilter     = searchParams.get('filter')

  const [showCreate,     setShowCreate]     = useState(false)
  const [activeTab,      setActiveTab]      = useState<string>('all')
  const [filterProperty, setFilterProperty] = useState<string>('all')
  const [filterPriority, setFilterPriority] = useState<string>(
    urlFilter === 'urgent' ? 'high' : 'all'
  )
  const [viewMode,       setViewMode]       = useState<'list' | 'calendar' | 'kanban'>('list')

  const [selectedWO, setSelectedWO] = useState<WorkOrderDetailData | null>(null)
  const [warning,    setWarning]    = useState<string | null>(null)
  const [selectedIds,  setSelectedIds]  = useState<Set<string>>(new Set())
  const [bulkActing,   startBulkAction] = useTransition()

  // "Show completed" toggle — the page query excludes completed/cancelled WOs
  // by default, so this fetches them lazily on first toggle.
  const [showCompleted,   setShowCompleted]   = useState(false)
  const [archivedWOs,     setArchivedWOs]     = useState<WorkOrderRow[]>([])
  const [archivedLoaded,  setArchivedLoaded]  = useState(false)
  const [loadingArchived, startLoadArchived]  = useTransition()

  const toggleShowCompleted = () => {
    const next = !showCompleted
    setShowCompleted(next)
    if (next && !archivedLoaded) {
      startLoadArchived(async () => {
        const archived = await fetchArchivedWorkOrders()
        setArchivedWOs(archived as unknown as WorkOrderRow[])
        setArchivedLoaded(true)
      })
    }
  }

  const allWorkOrders = showCompleted ? [...workOrders, ...archivedWOs] : workOrders

  const toggleSelect = (id: string) =>
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  const clearSelection = () => setSelectedIds(new Set())

  useEffect(() => {
    if (!warning) return
    const t = setTimeout(() => setWarning(null), 5000)
    return () => clearTimeout(t)
  }, [warning])

  // Filter work orders
  const filtered = allWorkOrders.filter((wo) => {
    if (activeTab !== 'all' && wo.status !== activeTab) return false
    if (filterProperty !== 'all' && wo.property_id !== filterProperty) return false
    if (filterPriority !== 'all' && wo.priority !== filterPriority) return false
    return true
  })

  // Stats
  const openCount    = workOrders.filter((w) => w.status !== 'completed' && w.status !== 'cancelled').length
  const urgentCount  = workOrders.filter((w) => w.priority === 'urgent' && w.status !== 'completed' && w.status !== 'cancelled').length
  const pendingCount = workOrders.filter((w) => w.status === 'pending').length

  return (
    <>
      {/* Vendor-notification warning toast */}
      {warning && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 text-sm"
          style={{
            background: 'var(--accent-amber-dim)',
            border:     '1px solid var(--accent-amber)',
            color:      'var(--accent-amber)',
          }}
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {warning}
          <button onClick={() => setWarning(null)} className="ml-2">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Page Header */}
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Maintenance</h1>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <p className="page-subtitle">{openCount} open work order{openCount !== 1 ? 's' : ''}</p>
            {urgentCount > 0 && (
              <span className="badge badge-red">
                <AlertTriangle className="w-3 h-3" />
                {urgentCount} urgent
              </span>
            )}
            {pendingCount > 0 && (
              <span className="badge badge-slate">
                {pendingCount} pending
              </span>
            )}
          </div>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary">
          <Plus className="w-4 h-4" />
          New Work Order
        </button>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 bg-card-themed border border-themed rounded-lg px-1 py-1 max-w-full mb-4">
        {STATUS_TABS.map((tab) => {
          const count = tab.key === 'all'
            ? allWorkOrders.length
            : allWorkOrders.filter((w) => w.status === tab.key).length
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                activeTab !== tab.key && 'text-muted-themed hover:text-secondary-themed'
              )}
              style={activeTab === tab.key ? {
                background: 'var(--bg-raised)',
                boxShadow:  'inset 0 0 0 1px var(--accent-gold)',
                color:      'var(--accent-gold)',
              } : undefined}
            >
              {tab.label}
              <span
                className={cn(
                  'px-1.5 py-0.5 rounded-full text-xs font-semibold',
                  activeTab !== tab.key && 'bg-raised-themed text-muted-themed'
                )}
                style={activeTab === tab.key ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        {properties.length > 1 && (
          <select
            value={filterProperty}
            onChange={(e) => setFilterProperty(e.target.value)}
            className="input text-sm py-1.5 w-auto"
          >
            <option value="all">All Properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className="input text-sm py-1.5 w-auto"
        >
          <option value="all">All Priorities</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        {(filterProperty !== 'all' || filterPriority !== 'all') && (
          <button
            onClick={() => { setFilterProperty('all'); setFilterPriority('all') }}
            className="btn-ghost text-xs py-1.5 text-muted-themed"
          >
            <X className="w-3 h-3" /> Clear filters
          </button>
        )}
        <label className="flex items-center gap-1.5 text-xs cursor-pointer text-muted-themed">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={toggleShowCompleted}
            disabled={loadingArchived}
            className="w-3.5 h-3.5 rounded border-themed text-brand-600 cursor-pointer"
          />
          {loadingArchived ? 'Loading completed…' : 'Show completed'}
        </label>

        {/* View toggle */}
        <div className="flex items-center gap-1 ml-auto flex-shrink-0 bg-card-themed border border-themed rounded-lg px-1 py-1">
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap',
              viewMode !== 'list' && 'text-muted-themed hover:text-secondary-themed'
            )}
            style={viewMode === 'list' ? {
              background: 'var(--bg-raised)',
              boxShadow:  'inset 0 0 0 1px var(--accent-gold)',
              color:      'var(--accent-gold)',
            } : undefined}
          >
            <List className="w-3.5 h-3.5" /> List
          </button>
          <button
            onClick={() => setViewMode('calendar')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap',
              viewMode !== 'calendar' && 'text-muted-themed hover:text-secondary-themed'
            )}
            style={viewMode === 'calendar' ? {
              background: 'var(--bg-raised)',
              boxShadow:  'inset 0 0 0 1px var(--accent-gold)',
              color:      'var(--accent-gold)',
            } : undefined}
          >
            <BarChart2 className="w-3.5 h-3.5" /> Calendar
          </button>
          <button
            onClick={() => setViewMode('kanban')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap',
              viewMode !== 'kanban' && 'text-muted-themed hover:text-secondary-themed'
            )}
            style={viewMode === 'kanban' ? {
              background: 'var(--bg-raised)',
              boxShadow:  'inset 0 0 0 1px var(--accent-gold)',
              color:      'var(--accent-gold)',
            } : undefined}
          >
            <LayoutGrid className="w-3.5 h-3.5" /> Kanban
          </button>
        </div>
      </div>

      {/* Calendar View */}
      {viewMode === 'calendar' && (
        <MaintenanceCalendar
          workOrders={allWorkOrders.filter(wo => wo.scheduled_date)}
          schedules={schedules}
        />
      )}

      {/* Work Orders List */}
      {viewMode === 'list' && (filtered.length === 0 ? (
        <div className="card text-center py-16 max-w-md mx-auto mt-4">
          <Wrench className="w-10 h-10 text-muted-themed mx-auto mb-3" />
          <h3 className="font-semibold text-secondary-themed mb-1">No work orders found</h3>
          <p className="text-sm text-muted-themed mb-4">
            {allWorkOrders.length === 0
              ? 'Create your first work order to track maintenance tasks.'
              : 'No work orders match the current filters.'
            }
          </p>
          {allWorkOrders.length === 0 && (
            <button onClick={() => setShowCreate(true)} className="btn-primary mx-auto">
              <Plus className="w-4 h-4" />
              New Work Order
            </button>
          )}
        </div>
      ) : (
        <div>
          {filtered.length > 1 && (
            <div className="flex items-center gap-3 mb-2">
              <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && filtered.every(wo => selectedIds.has(wo.id))}
                  onChange={() =>
                    filtered.every(wo => selectedIds.has(wo.id))
                      ? clearSelection()
                      : setSelectedIds(new Set(filtered.map(wo => wo.id)))
                  }
                  className="w-4 h-4 rounded border-themed text-brand-600 cursor-pointer"
                />
                {filtered.every(wo => selectedIds.has(wo.id))
                  ? `Deselect all (${filtered.length})`
                  : `Select all visible (${filtered.length})`}
              </label>
            </div>
          )}
          <div className="space-y-3">
            {filtered.map((wo) => (
              <WorkOrderCard
                key={wo.id}
                wo={wo}
                onClick={() => setSelectedWO(toWorkOrderDetailData(wo))}
                isSelected={selectedIds.has(wo.id)}
                onToggle={() => toggleSelect(wo.id)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Kanban View */}
      {viewMode === 'kanban' && (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {KANBAN_COLUMNS.map((col) => {
            const colWOs = filtered.filter((wo) => wo.status === col.key)
            return (
              <div key={col.key} className="flex-shrink-0 w-72">
                <div
                  className="flex items-center justify-between px-3 py-2 rounded-t-lg mb-2"
                  style={{ background: 'var(--bg-raised)', borderBottom: `2px solid ${col.accentColor}` }}
                >
                  <span className="text-xs font-semibold uppercase tracking-wide"
                        style={{ color: col.accentColor }}>
                    {col.label}
                  </span>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full"
                        style={{ background: 'var(--bg-canvas)', color: 'var(--text-muted)' }}>
                    {colWOs.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {colWOs.length === 0 && (
                    <div className="text-xs text-center py-6 rounded-lg"
                         style={{ color: 'var(--text-muted)', background: 'var(--bg-raised)' }}>
                      No work orders
                    </div>
                  )}
                  {colWOs.map((wo) => {
                    const prop = getJoined(wo.properties)
                    const vend = getJoined(wo.vendors)
                    return (
                      <button
                        key={wo.id}
                        onClick={() => setSelectedWO(toWorkOrderDetailData(wo))}
                        className="w-full text-left rounded-lg p-3 transition-all hover:shadow-md"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                      >
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                            {wo.wo_number ?? '—'}
                          </span>
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase"
                            style={{
                              background: wo.priority === 'urgent' ? 'rgba(240,84,84,0.15)'
                                        : wo.priority === 'high'   ? 'rgba(251,191,36,0.15)'
                                        : 'var(--bg-raised)',
                              color: wo.priority === 'urgent' ? 'var(--accent-red)'
                                   : wo.priority === 'high'   ? 'var(--accent-amber)'
                                   : 'var(--text-muted)',
                            }}
                          >
                            {wo.priority}
                          </span>
                        </div>
                        <p className="text-sm font-medium leading-snug mb-1"
                           style={{ color: 'var(--text-primary)' }}>
                          {wo.title}
                        </p>
                        <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                          {prop?.name ?? '—'}
                        </p>
                        {vend && (
                          <p className="text-xs mt-1 truncate" style={{ color: 'var(--text-muted)' }}>
                            {vend.name}
                          </p>
                        )}
                        {wo.scheduled_date && (
                          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            {new Date(wo.scheduled_date).toLocaleDateString('en-US', {
                              month: 'short', day: 'numeric',
                            })}
                          </p>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Maintenance Schedules */}
      <SchedulesSection schedules={schedules} properties={properties} vendors={vendors} />

      {/* Schedule Templates */}
      <TemplatesSection templates={templates} properties={properties} />

      {/* Create Modal */}
      {showCreate && (
        <CreateWorkOrderModal
          properties={properties}
          vendors={vendors}
          crewMembers={crewMembers}
          propertyAssets={propertyAssets}
          vendorCompliance={vendorCompliance}
          orgId={orgId}
          onClose={() => setShowCreate(false)}
          onWarning={setWarning}
        />
      )}

      {/* Work Order Detail Slide-Over */}
      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div
          className="fixed bottom-20 md:bottom-6 left-4 right-4 md:left-1/2 md:-translate-x-1/2 md:w-auto z-30 flex flex-col gap-2 px-4 py-3 rounded-2xl shadow-xl"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', maxWidth: '520px', margin: '0 auto' }}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
              {selectedIds.size} selected
            </span>
            <button onClick={clearSelection} className="btn-ghost text-xs flex-shrink-0 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="input text-sm py-1.5 flex-1"
              defaultValue=""
              disabled={bulkActing}
              onChange={(e) => {
                if (!e.target.value) return
                const vendorId = e.target.value
                e.target.value = ''
                startBulkAction(async () => {
                  await bulkAssignVendor([...selectedIds], vendorId)
                  clearSelection()
                })
              }}
            >
              <option value="" disabled>Assign vendor…</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <select
              className="input text-sm py-1.5 flex-1"
              defaultValue=""
              disabled={bulkActing}
              onChange={(e) => {
                if (!e.target.value) return
                const status = e.target.value as WoStatus
                e.target.value = ''
                startBulkAction(async () => {
                  await bulkUpdateWorkOrderStatus([...selectedIds], status)
                  clearSelection()
                })
              }}
            >
              <option value="" disabled>Set status…</option>
              <option value="assigned">Assigned</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>
      )}

      {selectedWO && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(0,0,0,0.5)' }}
            role="button"
            tabIndex={0}
            aria-label="Close work order detail"
            onClick={() => setSelectedWO(null)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedWO(null) } }}
          />

          {/* Panel */}
          <div
            className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl flex flex-col shadow-2xl"
            style={{ background: 'var(--bg-base)' }}
          >
            {/* Panel header */}
            <div
              className="flex items-center justify-between px-6 py-4 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--border)' }}
            >
              <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
                Work Order Detail
              </span>
              <button
                onClick={() => setSelectedWO(null)}
                className="p-2 rounded-lg transition-colors"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto">
              <WorkOrderDetail
                workOrder={selectedWO}
                userRole={role as 'admin' | 'manager' | 'crew' | 'viewer'}
                onClose={() => setSelectedWO(null)}
                vendors={vendors.map(v => ({ id: v.id, name: v.name, email: v.email }))}
              />
            </div>
          </div>
        </>
      )}
    </>
  )
}
