'use client'

import { useState, useTransition, useActionState, useRef, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Plus, ChevronDown, X, Wrench, Calendar, DollarSign,
  User, ChevronRight, AlertTriangle, CheckCircle2, Clock,
  Pencil, Trash2, Camera, List, BarChart2,
} from 'lucide-react'
import { cn, formatDate, WO_STATUS_LABELS } from '@/lib/utils'
import {
  createWorkOrder, createWorkOrderFromSchedule,
  createMaintenanceSchedule, updateMaintenanceSchedule, deleteMaintenanceSchedule,
} from './actions'
import type { WoStatus, PriorityLevel, VendorSpecialty, ScheduleType, ScheduleFrequency } from '@/types/database'
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
  created_at: string
  updated_at: string
  properties: { name: string; address: string | null; city: string | null; state: string | null; access_instructions: string | null } | { name: string; address: string | null; city: string | null; state: string | null; access_instructions: string | null }[] | null
  vendors: { id: string; name: string; specialty: string } | { id: string; name: string; specialty: string }[] | null
  work_order_line_items?: Array<{
    id: string; work_order_id?: string; line_type: string; description: string
    quantity: number; unit: string | null; unit_cost: number; line_total: number
    sort_order: number; created_at: string
  }>
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
}

interface CrewMemberOption {
  id: string
  name: string
  role: string
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getJoined<T>(val: T | T[] | null): T | null {
  if (!val) return null
  return Array.isArray(val) ? val[0] ?? null : val
}

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
}: {
  wo: WorkOrderRow
  onClick: () => void
}) {
  const property = getJoined(wo.properties)
  const vendor   = getJoined(wo.vendors)

  return (
    <div
      onClick={onClick}
      className={cn(
        'bg-card-themed rounded-xl border border-themed p-4 cursor-pointer',
        'hover:shadow-[0_2px_8px_0_rgba(0,0,0,.08)] hover:border-themed transition-all',
        wo.priority === 'urgent' && 'border-l-4 border-l-red-400',
        wo.priority === 'high'   && 'border-l-4 border-l-amber-400',
      )}
    >
      <div className="flex items-start gap-3">
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
  orgId = '',
  onClose,
}: {
  properties:   PropertyOption[]
  vendors:      VendorOption[]
  crewMembers?: CrewMemberOption[]
  orgId?:       string
  onClose:      () => void
}) {
  const [state, action, pending]          = useActionState(createWorkOrder, null)
  const [assignMode,         setAssignMode]         = useState<'vendor' | 'crew' | 'quotes'>('vendor')
  const [selectedVendor,     setSelectedVendor]     = useState('')
  const [selectedQuoteVendors, setSelectedQuoteVendors] = useState<string[]>([])
  const [photoFiles,         setPhotoFiles]         = useState<File[]>([])
  const photoInputRef = useRef<HTMLInputElement | null>(null)

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setPhotoFiles(prev => [...prev, ...files])
    e.target.value = ''
  }

  const removePhoto = (i: number) =>
    setPhotoFiles(prev => prev.filter((_, idx) => idx !== i))

  // After successful WO creation, upload photos
  useEffect(() => {
    if (!state?.success || !state.workOrderId || !photoFiles.length) return
    const workOrderId = state.workOrderId
    ;(async () => {
      const supabase = createClient()
      for (const file of photoFiles) {
        const ext  = file.name.split('.').pop() ?? 'jpg'
        const path = `wo-${workOrderId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const { error: uploadErr } = await supabase.storage
          .from('work-order-photos')
          .upload(path, file, { contentType: file.type })
        if (!uploadErr) {
          await supabase.from('work_order_photos').insert({
            work_order_id: workOrderId,
            org_id:        orgId,
            storage_path:  path,
          })
        }
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
                <select id="wo-property" name="property_id" required className="input">
                  <option value="">Select property…</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

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
                    assignMode === 'vendor'
                      ? 'bg-brand-800 text-white'
                      : 'text-muted-themed hover:text-secondary-themed'
                  )}
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
                    assignMode === 'crew'
                      ? 'bg-brand-800 text-white'
                      : 'text-muted-themed hover:text-secondary-themed'
                  )}
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
                    assignMode === 'quotes'
                      ? 'bg-brand-800 text-white'
                      : 'text-muted-themed hover:text-secondary-themed'
                  )}
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
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                  {selectedVendor && (
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
            <button type="submit" disabled={pending} className="btn-primary flex-1">
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
        <input type="checkbox" name="auto_create_wo" defaultChecked={defaults?.auto_create_wo ?? false} className="w-4 h-4 rounded" />
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
    startDelete(async () => {
      await deleteMaintenanceSchedule(scheduleId)
      setDeletingId(null)
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

// ── Main Board ────────────────────────────────────────────────────────────────

export function MaintenanceBoard({
  workOrders,
  properties,
  vendors,
  schedules,
  crewMembers = [],
  orgId = '',
  role,
}: {
  workOrders:   WorkOrderRow[]
  properties:   PropertyOption[]
  vendors:      VendorOption[]
  schedules:    ScheduleRow[]
  crewMembers?: CrewMemberOption[]
  orgId?:       string
  role:         string
}) {
  const searchParams  = useSearchParams()
  const urlFilter     = searchParams.get('filter')

  const [showCreate,     setShowCreate]     = useState(false)
  const [activeTab,      setActiveTab]      = useState<string>('all')
  const [filterProperty, setFilterProperty] = useState<string>('all')
  const [filterPriority, setFilterPriority] = useState<string>(
    urlFilter === 'urgent' ? 'high' : 'all'
  )
  const [viewMode,       setViewMode]       = useState<'list' | 'calendar'>('calendar')

  const [selectedWO, setSelectedWO] = useState<WorkOrderDetailData | null>(null)

  // Filter work orders
  const filtered = workOrders.filter((wo) => {
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
      <div className="flex items-center gap-1 bg-card-themed border border-themed rounded-lg px-1 py-1 w-fit mb-4">
        {STATUS_TABS.map((tab) => {
          const count = tab.key === 'all'
            ? workOrders.length
            : workOrders.filter((w) => w.status === tab.key).length
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                activeTab === tab.key
                  ? 'bg-brand-800 text-white'
                  : 'text-muted-themed hover:text-secondary-themed'
              )}
            >
              {tab.label}
              <span className={cn(
                'px-1.5 py-0.5 rounded-full text-xs font-semibold',
                activeTab === tab.key ? 'bg-brand-700 text-brand-100' : 'bg-raised-themed text-muted-themed'
              )}>
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

        {/* View toggle */}
        <div className="flex items-center gap-1 ml-auto bg-card-themed border border-themed rounded-lg px-1 py-1">
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1',
              viewMode === 'list' ? 'bg-brand-800 text-white' : 'text-muted-themed hover:text-secondary-themed'
            )}
          >
            <List className="w-3.5 h-3.5" /> List
          </button>
          <button
            onClick={() => setViewMode('calendar')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1',
              viewMode === 'calendar' ? 'bg-brand-800 text-white' : 'text-muted-themed hover:text-secondary-themed'
            )}
          >
            <BarChart2 className="w-3.5 h-3.5" /> Calendar
          </button>
        </div>
      </div>

      {/* Calendar View */}
      {viewMode === 'calendar' && (
        <MaintenanceCalendar
          workOrders={workOrders.filter(wo => wo.scheduled_date)}
          schedules={schedules}
        />
      )}

      {/* Work Orders List */}
      {viewMode === 'list' && (filtered.length === 0 ? (
        <div className="card text-center py-16 max-w-md mx-auto mt-4">
          <Wrench className="w-10 h-10 text-muted-themed mx-auto mb-3" />
          <h3 className="font-semibold text-secondary-themed mb-1">No work orders found</h3>
          <p className="text-sm text-muted-themed mb-4">
            {workOrders.length === 0
              ? 'Create your first work order to track maintenance tasks.'
              : 'No work orders match the current filters.'
            }
          </p>
          {workOrders.length === 0 && (
            <button onClick={() => setShowCreate(true)} className="btn-primary mx-auto">
              <Plus className="w-4 h-4" />
              New Work Order
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((wo) => {
            const prop = getJoined(wo.properties)
            const vend = getJoined(wo.vendors)
            return (
              <WorkOrderCard
                key={wo.id}
                wo={wo}
                onClick={() => setSelectedWO({
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
                  } : null,
                  work_order_line_items: (wo.work_order_line_items ?? []) as WorkOrderDetailData['work_order_line_items'],
                })}
              />
            )
          })}
        </div>
      ))}

      {/* Maintenance Schedules */}
      <SchedulesSection schedules={schedules} properties={properties} vendors={vendors} />

      {/* Create Modal */}
      {showCreate && (
        <CreateWorkOrderModal
          properties={properties}
          vendors={vendors}
          crewMembers={crewMembers}
          orgId={orgId}
          onClose={() => setShowCreate(false)}
        />
      )}

      {/* Work Order Detail Slide-Over */}
      {selectedWO && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(0,0,0,0.5)' }}
            onClick={() => setSelectedWO(null)}
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
              />
            </div>
          </div>
        </>
      )}
    </>
  )
}
