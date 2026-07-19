'use client'

import { useState, useTransition, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Plus, ChevronDown, X, Wrench, Calendar, DollarSign,
  User, ChevronRight, AlertTriangle, CheckCircle2, Clock,
  Pencil, Trash2, List, BarChart2, Send, LayoutGrid, Loader2,
  Check, Sparkles,
} from 'lucide-react'
import { cn, formatDate, WO_STATUS_LABELS } from '@/lib/utils'
import {
  createWorkOrderFromSchedule,
  createMaintenanceSchedule, updateMaintenanceSchedule, deleteMaintenanceSchedule,
  broadcastMaintenanceTemplate, createMaintenanceScheduleTemplate, updateMaintenanceTemplate, type BroadcastResult,
  bulkAssignVendor, bulkUpdateWorkOrderStatus, fetchArchivedWorkOrders,
  acceptVendorSuggestion, dismissVendorSuggestion,
} from './actions'
import type { WoStatus, PriorityLevel, VendorSpecialty, ScheduleType, ScheduleFrequency, ComplianceStatus } from '@/types/database'
import { WorkOrderDetail, type WorkOrderDetailData } from '@/components/work-orders/work-order-detail'
import { MaintenanceCalendar } from './maintenance-calendar'
import { CreateWorkOrderModal } from './CreateWorkOrderModal'
import { Dialog } from '@/components/ui/Dialog'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button, buttonVariantClass } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { RequiredMark } from '@/components/ui/RequiredMark'

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
  completed_by_name: string | null
  invoice_reference: string | null
  vendor_acknowledged_at: string | null
  vendor_acknowledged_by: string | null
  completion_verified_at: string | null
  completion_verified_by: string | null
  vendor_dispatch_email: string | null
  suggested_vendor_ids: string[] | null
  suggestion_reasoning: string | null
  suggestion_status: 'pending' | 'accepted' | 'overridden' | 'dismissed' | null
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

export interface CrewMemberOption {
  id: string
  name: string
  role: string
}

export interface AssetOption {
  id:          string
  name:        string
  asset_type:  string
  property_id: string
}

export interface VendorComplianceRow {
  vendor_id:         string
  compliance_status: ComplianceStatus
}

export interface PropertyOptionWithCoords extends PropertyOption {
  lat: number | null
  lng: number | null
}

export interface VendorOptionWithCoords extends VendorOption {
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
    completed_by_name:      wo.completed_by_name,
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
  { key: 'in_progress', label: 'In Progress', accentColor: 'var(--accent-purple)' },
  { key: 'completed',   label: 'Completed',   accentColor: 'var(--accent-green)' },
]

type BadgeTone = 'green' | 'amber' | 'red' | 'blue' | 'gold' | 'slate'

function priorityBadgeTone(priority: PriorityLevel): BadgeTone {
  const map: Record<PriorityLevel, BadgeTone> = {
    low:    'slate',
    medium: 'blue',
    high:   'amber',
    urgent: 'red',
  }
  return map[priority]
}

function statusBadgeTone(status: WoStatus): BadgeTone {
  const map: Record<WoStatus, BadgeTone> = {
    pending:         'slate',
    quote_requested: 'gold',
    assigned:        'blue',
    in_progress:     'amber',
    completed:       'green',
    cancelled:       'slate',
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

const VIEW_MODE_TABS = [
  { key: 'list' as const,     label: 'List',     icon: List },
  { key: 'calendar' as const, label: 'Calendar', icon: BarChart2 },
  { key: 'kanban' as const,   label: 'Kanban',    icon: LayoutGrid },
]

// ── Work Order Card ───────────────────────────────────────────────────────────

function WorkOrderCard({
  wo,
  vendors,
  onClick,
  isSelected,
  onToggle,
}: {
  wo: WorkOrderRow
  vendors: VendorOptionWithCoords[]
  onClick: () => void
  isSelected: boolean
  onToggle: () => void
}) {
  const property = getJoined(wo.properties)
  const vendor   = getJoined(wo.vendors)

  const [accepting,  startAccept]  = useTransition()
  const [dismissing, startDismiss] = useTransition()

  const suggestedVendorName = (wo.suggested_vendor_ids ?? [])
    .map((id) => vendors.find((v) => v.id === id)?.name)
    .filter(Boolean)[0] as string | undefined

  const handleAcceptSuggestion = (e: React.MouseEvent) => {
    e.stopPropagation()
    startAccept(async () => { await acceptVendorSuggestion(wo.id) })
  }

  const handleDismissSuggestion = (e: React.MouseEvent) => {
    e.stopPropagation()
    startDismiss(async () => { await dismissVendorSuggestion(wo.id) })
  }

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
        <Checkbox
          checked={isSelected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 flex-shrink-0"
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
            <Badge tone={priorityBadgeTone(wo.priority)}>
              {PRIORITY_LABELS[wo.priority]}
            </Badge>
            <Badge tone={statusBadgeTone(wo.status)}>
              {WO_STATUS_LABELS[wo.status]}
            </Badge>
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
                {wo.status === 'completed' && wo.completed_by_name && ` (${wo.completed_by_name})`}
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

          {/* Auto-suggestion banner */}
          {wo.suggestion_status === 'pending' && suggestedVendorName && (
            <div
              className="mt-2 flex items-center gap-2 flex-wrap px-3 py-2 rounded-lg"
              style={{ background: 'var(--accent-blue-dim)', border: '1px solid var(--accent-blue)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-xs inline-flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
                <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                Suggested: <strong style={{ color: 'var(--text-primary)' }}>{suggestedVendorName}</strong>
              </span>
              {wo.suggestion_reasoning && (
                <span className="text-xs hidden sm:inline" style={{ color: 'var(--text-muted)' }}>
                  — {wo.suggestion_reasoning}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={handleAcceptSuggestion}
                  disabled={accepting || dismissing}
                  className="text-xs px-2.5 py-1 rounded-lg font-medium disabled:opacity-50 transition-colors inline-flex items-center gap-1"
                  style={{ background: 'var(--accent-green)', color: '#fff' }}
                >
                  {accepting ? '…' : <><Check className="w-3.5 h-3.5" /> Accept</>}
                </button>
                <button
                  onClick={handleDismissSuggestion}
                  disabled={accepting || dismissing}
                  className="text-xs px-2 py-1 rounded-lg transition-colors disabled:opacity-50"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {dismissing ? '…' : 'Dismiss'}
                </button>
              </div>
            </div>
          )}
        </div>

        <ChevronRight className="w-4 h-4 text-muted-themed flex-shrink-0 mt-0.5" />
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
        <label className="label">Name <RequiredMark /></label>
        <Input name="name" type="text" required defaultValue={defaults?.name ?? ''} placeholder="e.g. HVAC Filter Change" />
      </div>

      {!defaults && (
        <div>
          <label className="label">Property <RequiredMark /></label>
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
          <Input name="next_due_date" type="date" defaultValue={defaults?.next_due_date ?? ''} />
        </div>
        <div>
          <label className="label">Est. Cost ($)</label>
          <Input name="estimated_cost" type="number" min="0" step="0.01" defaultValue={defaults?.estimated_cost ?? ''} placeholder="0.00" />
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
        <Checkbox name="auto_create_wo" defaultChecked={defaults?.auto_create_wo ?? true} />
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
    <Dialog open onClose={onClose} title="Add Maintenance Schedule">
        <form onSubmit={handleSubmit} className="flex flex-col max-h-[85vh] -m-6">
          <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
            {error && (
              <InlineAlert tone="error">{error}</InlineAlert>
            )}
            <ScheduleFormFields properties={properties} vendors={vendors} />
          </div>{/* /scrollable content */}
          <div className="flex gap-3 px-6 pb-6 pt-4 border-t border-themed flex-shrink-0">
            <Button type="submit" disabled={saving} className="flex-1">{saving ? 'Saving…' : 'Add Schedule'}</Button>
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
    </Dialog>
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
    <Dialog open onClose={onClose} title="Edit Schedule">
        <form onSubmit={handleSubmit} className="flex flex-col max-h-[85vh] -m-6">
          <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
            {error && (
              <InlineAlert tone="error">{error}</InlineAlert>
            )}
            <ScheduleFormFields properties={[]} vendors={vendors} defaults={schedule} />
          </div>{/* /scrollable content */}
          <div className="flex gap-3 px-6 pb-6 pt-4 border-t border-themed flex-shrink-0">
            <Button type="submit" disabled={saving} className="flex-1">{saving ? 'Saving…' : 'Save Changes'}</Button>
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
    </Dialog>
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
            <Badge tone="slate">{schedules.length}</Badge>
            <ChevronDown className={cn('w-4 h-4 text-muted-themed ml-auto transition-transform', open && 'rotate-180')} />
          </button>
          <Button
            variant="secondary"
            onClick={() => setShowAdd(true)}
            className="text-xs py-1.5 px-3 flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            Add Schedule
          </Button>
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
            No schedules yet. Click &quot;Add Schedule&quot; to create one.
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
                          <Badge tone="green">Auto</Badge>
                        ) : (
                          <Badge tone="slate">Manual</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="secondary"
                            onClick={() => handleCreateWO(s.id)}
                            disabled={creating && creatingId === s.id}
                            className="text-xs py-1.5 px-3 whitespace-nowrap"
                          >
                            {creating && creatingId === s.id ? <Clock className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                            Create WO
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setEditingId(s.id)}
                            className="p-1.5"
                            title="Edit schedule"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => handleDelete(s.id)}
                            disabled={deleting && deletingId === s.id}
                            className="p-1.5 text-red-500 hover:text-red-600"
                            title="Delete schedule"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
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
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<string[]>([])
  const [broadcasting, setBroadcasting]       = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [result, setResult]                   = useState<BroadcastResult | null>(null)

  const items        = template.maintenance_schedule_template_items
  const allSelected  = properties.length > 0 && selectedPropertyIds.length === properties.length
  const totalItems   = items.length * selectedPropertyIds.length

  const toggleProperty = (id: string) => {
    setSelectedPropertyIds((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id])
  }

  const toggleAll = () => {
    setSelectedPropertyIds(allSelected ? [] : properties.map((p) => p.id))
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
    <Dialog open onClose={onClose} title="Broadcast Template">
        <p className="text-xs text-muted-themed -mt-3 mb-4">{template.name} · {items.length} item{items.length !== 1 ? 's' : ''}</p>

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
          <InlineAlert tone="error" className="mb-4">{error}</InlineAlert>
        )}

        {result ? (
          <div className="space-y-4">
            <InlineAlert tone="success">
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
            </InlineAlert>
            <Button onClick={onClose} className="w-full">Done</Button>
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
                          <Badge tone="amber" className="text-xs flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            {item.is_optional_flag}
                          </Badge>
                        )}
                        <Badge tone="slate" className="text-xs">
                          {FREQUENCY_LABELS[item.schedule_frequency] ?? item.schedule_frequency}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-3 pt-4 mt-2 border-t border-themed">
                  <Button onClick={() => setStep(2)} className="flex-1">Continue</Button>
                  <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
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
                  <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
                  <Button
                    onClick={() => setStep(3)}
                    disabled={selectedPropertyIds.length === 0}
                    className="flex-1"
                  >
                    Continue
                  </Button>
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
                  <Button variant="ghost" onClick={() => setStep(2)} disabled={broadcasting}>Back</Button>
                  <Button
                    onClick={handleBroadcast}
                    disabled={broadcasting}
                    className="flex-1 flex items-center justify-center gap-2"
                  >
                    {broadcasting ? <Clock className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    {broadcasting ? 'Broadcasting…' : 'Broadcast'}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
    </Dialog>
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
  const [description, setDescription]    = useState('')
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
      <Dialog open onClose={onClose} title="Apply Template">
          <p className="text-xs text-muted-themed -mt-3 mb-4">&quot;{createdTemplateName}&quot; was created</p>

          {applyError && (
            <InlineAlert tone="error" className="mb-4">{applyError}</InlineAlert>
          )}

          {applyResult ? (
            <div className="space-y-4">
              <InlineAlert tone="success" className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Template applied</p>
                  <p className="mt-1">
                    Created {applyResult.created} schedule{applyResult.created !== 1 ? 's' : ''}
                    {(applyResult.skipped ?? 0) > 0 && <> · {applyResult.skipped} skipped (already existed)</>}
                  </p>
                </div>
              </InlineAlert>
              <Button onClick={onClose} className="w-full">Done</Button>
            </div>
          ) : properties.length === 0 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-themed">No properties found to apply this template to. You can broadcast it later from the Schedule Templates list.</p>
              <Button onClick={onClose} className="w-full">Done</Button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-secondary-themed">Apply this template&apos;s schedules now?</p>
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
                <Button variant="ghost" type="button" onClick={onClose}>Skip</Button>
                <Button
                  onClick={handleApply}
                  disabled={applying || (applyMode === 'select' && selectedPropertyIds.length === 0)}
                  className="flex-1 flex items-center justify-center gap-2"
                >
                  {applying ? <Clock className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {applying ? 'Applying…' : 'Apply Template'}
                </Button>
              </div>
            </div>
          )}
      </Dialog>
    )
  }

  return (
    <Dialog open onClose={onClose} title="Create Schedule Template" maxWidthClassName="max-w-2xl">
        <form onSubmit={handleSubmit} className="flex flex-col max-h-[85vh] -m-6">
          <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
          {error && (
            <InlineAlert tone="error">{error}</InlineAlert>
          )}
          <div>
            <label className="label">Template Name <RequiredMark /></label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. STR Annual Maintenance" required />
          </div>
          <div>
            <label className="label">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description…" />
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
                                <Badge tone="amber" className="text-xs flex-shrink-0 flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3" />
                                  {ci.is_optional_flag}
                                </Badge>
                              )}
                              <Badge tone="slate" className="text-xs flex-shrink-0">
                                {FREQUENCY_LABELS[ci.schedule_frequency] ?? ci.schedule_frequency}
                              </Badge>
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
              <label className="label mb-0">Items <RequiredMark /></label>
              <Button variant="secondary" type="button" onClick={addItem} className="text-xs py-1 px-2 flex items-center gap-1">
                <Plus className="w-3 h-3" /> Add Item
              </Button>
            </div>
            <div className="space-y-2">
              {items.map((item, i) => (
                <div key={i} className="border border-themed rounded-xl p-3 space-y-2 bg-canvas-themed">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="label text-xs">Item Name <RequiredMark /></label>
                        <Input value={item.name} onChange={(e) => updateItem(i, 'name', e.target.value)}
                               className="text-sm" placeholder="e.g. HVAC Filter Replacement" />
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
                        <Input type="number" min="0" step="0.01" value={item.estimated_cost}
                               onChange={(e) => updateItem(i, 'estimated_cost', e.target.value)}
                               className="text-sm" placeholder="0.00" />
                      </div>
                    </div>
                    {items.length > 1 && (
                      <Button variant="ghost" type="button" onClick={() => removeItem(i)}
                              className="p-1.5 text-red-500 hover:text-red-600 mt-5 flex-shrink-0">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          </div>{/* /scrollable content */}

          <div className="flex gap-3 px-6 pb-6 pt-4 border-t border-themed flex-shrink-0">
            <Button type="submit" disabled={saving} className="flex-1">
              {saving ? 'Creating…' : 'Create Template'}
            </Button>
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
    </Dialog>
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
            <Badge tone="slate">{templates.length}</Badge>
            <ChevronDown className={cn('w-4 h-4 text-muted-themed ml-auto transition-transform', open && 'rotate-180')} />
          </button>
          <Button
            variant="secondary"
            onClick={() => setShowCreateTemplate(true)}
            className="text-xs py-1.5 px-3 flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            Create Template
          </Button>
        </div>
        <p className="text-xs text-muted-themed mb-3">
          Broadcast a curated set of recurring maintenance schedules to multiple properties at once
        </p>

        {open && templates.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-themed border border-themed rounded-xl">
            No templates yet. Click &quot;Create Template&quot; to build one.
          </div>
        )}

        {open && templates.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {templates.map((t) => {
              const items   = t.maintenance_schedule_template_items
              const preview = items.slice(0, 4)
              return (
                <div key={t.id} className="bg-card-themed rounded-xl border border-themed p-4 flex flex-col">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="font-medium text-primary-themed text-sm">{t.name}</span>
                    {t.is_system && (
                      <Badge
                        tone="blue"
                        className="flex-shrink-0"
                        title="This is a read-only FieldStay template. Create your own template to customise it."
                      >
                        FieldStay · Read-only
                      </Badge>
                    )}
                  </div>
                  {t.description && (
                    <p className="text-xs text-muted-themed mb-2 truncate">{t.description}</p>
                  )}
                  <Badge tone="slate" className="w-fit mb-2">{items.length} item{items.length !== 1 ? 's' : ''}</Badge>
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
                        className={buttonVariantClass('ghost') + ' text-xs py-1.5 px-3 flex items-center gap-1 flex-shrink-0'}
                      >
                        <Pencil className="w-3 h-3" />
                        Edit
                      </Link>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() => setBroadcastTemplateId(t.id)}
                      disabled={properties.length === 0}
                      className="text-xs py-1.5 px-3 flex items-center justify-center gap-1.5 flex-1"
                    >
                      <Send className="w-3 h-3" />
                      Broadcast
                    </Button>
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
    <Dialog open onClose={onClose} title="Edit Template" maxWidthClassName="max-w-md">
        {success ? (
          <div className="text-center py-4">
            <p className="text-sm font-medium mb-4 flex items-center justify-center gap-1.5" style={{ color: 'var(--accent-green)' }}>
              <Check className="w-4 h-4" />
              Template updated
            </p>
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="label">Template Name <RequiredMark /></label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                className="w-full"
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
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 flex items-center justify-center gap-2"
              >
                {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save Changes'}
              </Button>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </div>
        )}
    </Dialog>
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
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
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
              <Badge tone="red">
                <AlertTriangle className="w-3 h-3" />
                {urgentCount} urgent
              </Badge>
            )}
            {pendingCount > 0 && (
              <Badge tone="slate">
                {pendingCount} pending
              </Badge>
            )}
          </div>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4" />
          New Work Order
        </Button>
      </div>

      {/* Tabs */}
      <div role="tablist" className="flex flex-wrap items-center gap-1 bg-card-themed border border-themed rounded-lg px-1 py-1 max-w-full mb-4">
        {STATUS_TABS.map((tab) => {
          const count = tab.key === 'all'
            ? allWorkOrders.length
            : allWorkOrders.filter((w) => w.status === tab.key).length
          const isActive = activeTab === tab.key
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                'focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]',
                !isActive && 'text-muted-themed hover:text-secondary-themed'
              )}
              style={isActive ? {
                background: 'var(--bg-raised)',
                boxShadow:  'inset 0 0 0 1px var(--accent-gold)',
                color:      'var(--accent-gold)',
              } : undefined}
            >
              {tab.label}
              <span
                className={cn(
                  'px-1.5 py-0.5 rounded-full text-xs font-semibold',
                  !isActive && 'bg-raised-themed text-muted-themed'
                )}
                style={isActive ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
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
          <Button
            variant="ghost"
            onClick={() => { setFilterProperty('all'); setFilterPriority('all') }}
            className="text-xs py-1.5 text-muted-themed"
          >
            <X className="w-3 h-3" /> Clear filters
          </Button>
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

        {/* View toggle — same pill style as the status tabs above, for visual
            consistency on this page (see turnover-urgency.ts-style rationale
            in CLAUDE.md: a deliberate variant of Tabs, not a plain miss, so
            role/aria-selected/focus-ring are added directly here rather than
            forcing this onto Tabs' different underline visual style). */}
        <div role="tablist" className="flex items-center gap-1 ml-auto flex-shrink-0 bg-card-themed border border-themed rounded-lg px-1 py-1">
          {VIEW_MODE_TABS.map((tab) => {
            const isActive = viewMode === tab.key
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={isActive}
                onClick={() => setViewMode(tab.key)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap',
                  'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]',
                  !isActive && 'text-muted-themed hover:text-secondary-themed'
                )}
                style={isActive ? {
                  background: 'var(--bg-raised)',
                  boxShadow:  'inset 0 0 0 1px var(--accent-gold)',
                  color:      'var(--accent-gold)',
                } : undefined}
              >
                <tab.icon className="w-3.5 h-3.5" /> {tab.label}
              </button>
            )
          })}
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
        <Card className="text-center py-16 max-w-md mx-auto mt-4">
          <Wrench className="w-10 h-10 text-muted-themed mx-auto mb-3" />
          <h3 className="font-semibold text-secondary-themed mb-1">No work orders found</h3>
          <p className="text-sm text-muted-themed mb-4">
            {allWorkOrders.length === 0
              ? 'Create your first work order to track maintenance tasks.'
              : 'No work orders match the current filters.'
            }
          </p>
          {allWorkOrders.length === 0 && (
            <Button onClick={() => setShowCreate(true)} className="mx-auto">
              <Plus className="w-4 h-4" />
              New Work Order
            </Button>
          )}
        </Card>
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
                vendors={vendors}
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
                            {wo.completed_by_name && ` (${wo.completed_by_name})`}
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
            <Button variant="ghost" onClick={clearSelection} className="text-xs flex-shrink-0 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
              <X className="w-3.5 h-3.5" /> Clear
            </Button>
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
                  const result = await bulkUpdateWorkOrderStatus([...selectedIds], status)
                  if (result.error) setWarning(result.error)
                  else if (result.warning) setWarning(result.warning)
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
        <Dialog
          open
          onClose={() => setSelectedWO(null)}
          title="Work Order Detail"
          maxWidthClassName="max-w-2xl"
        >
          <div className="max-h-[85vh] -m-6 flex flex-col">
            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto min-h-0">
              <WorkOrderDetail
                workOrder={selectedWO}
                userRole={role as 'admin' | 'manager' | 'crew' | 'viewer'}
                vendors={vendors.map(v => ({ id: v.id, name: v.name, email: v.email }))}
              />
            </div>
          </div>
        </Dialog>
      )}
    </>
  )
}
