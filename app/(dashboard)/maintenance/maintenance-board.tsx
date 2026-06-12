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
  updateWorkOrderStatus, deleteWorkOrderLineItem,
  updateMaintenanceTemplate,
} from './actions'
import {
  addMaintenanceSchedule, updateMaintenanceSchedule,
  deleteMaintenanceSchedule,
} from './schedule-actions'
import type { WorkOrder, MaintenanceSchedule, Vendor, Property, CrewMember } from '@/types/database'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ChecklistTemplate {
  id:   string
  name: string
  is_system?: boolean
}

interface MaintenanceBoardProps {
  workOrders:           WorkOrder[]
  schedules:            MaintenanceSchedule[]
  vendors:              Vendor[]
  properties:           Property[]
  crew:                 CrewMember[]
  checklistTemplates:   ChecklistTemplate[]
  orgId:                string
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const WO_CATEGORY_LABELS: Record<string, string> = {
  hvac: 'HVAC', plumbing: 'Plumbing', electrical: 'Electrical',
  appliance: 'Appliance', cleaning: 'Cleaning', landscaping: 'Landscaping',
  roofing: 'Roofing', flooring: 'Flooring', windows_doors: 'Windows & Doors',
  pest_control: 'Pest Control', pool: 'Pool', structural: 'Structural',
  general: 'General', other: 'Other',
}

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent',
}

const PRIORITY_COLORS: Record<string, string> = {
  low:    'var(--text-muted)',
  medium: 'var(--accent-gold)',
  high:   'var(--accent-amber)',
  urgent: 'var(--accent-red)',
}

const FREQ_LABELS: Record<string, string> = {
  weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly',
  quarterly: 'Quarterly', semi_annual: 'Semi-Annual', annual: 'Annual',
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit Template Modal
// ─────────────────────────────────────────────────────────────────────────────

function EditTemplateModal({
  template,
  onClose,
}: {
  template: ChecklistTemplate
  onClose:  () => void
}) {
  const [name, setName]   = useState(template.name)
  const [saving, startSave] = useTransition()
  const [error, setError]   = useState<string | null>(null)

  function handleSave() {
    setError(null)
    startSave(async () => {
      const result = await updateMaintenanceTemplate(template.id, { name })
      if (result.error) setError(result.error)
      else onClose()
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        className="rounded-2xl shadow-card-lg p-6 w-full max-w-sm space-y-4"
        style={{ background: 'var(--bg-card)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-primary-themed">Edit Template</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        {error && (
          <div className="text-xs rounded-lg px-3 py-2"
               style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
            {error}
          </div>
        )}

        <div>
          <label className="label">Template Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
            placeholder="Template name"
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="btn-primary flex-1 flex items-center justify-center gap-2"
          >
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save'}
          </button>
          <button onClick={onClose} className="btn-ghost">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Board
// ─────────────────────────────────────────────────────────────────────────────

export function MaintenanceBoard({
  workOrders, schedules, vendors, properties, crew, checklistTemplates,
}: MaintenanceBoardProps) {
  const searchParams = useSearchParams()
  const defaultTab   = (searchParams.get('tab') as 'work-orders' | 'schedules' | 'checklists') ?? 'work-orders'

  const [activeTab, setActiveTab] = useState<'work-orders' | 'schedules' | 'checklists'>(defaultTab)
  const [editTemplateId, setEditTemplateId] = useState<string | null>(null)

  const editTemplate = editTemplateId
    ? checklistTemplates.find((t) => t.id === editTemplateId) ?? null
    : null

  return (
    <div className="space-y-6">
      {/* Tab bar */}
      <div className="flex gap-1 rounded-xl p-1 w-fit" style={{ background: 'var(--bg-raised)' }}>
        {(['work-orders', 'schedules', 'checklists'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={activeTab === tab
              ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
              : { color: 'var(--text-muted)' }}
          >
            {tab === 'work-orders' ? 'Work Orders' : tab === 'schedules' ? 'Schedules' : 'Checklists'}
          </button>
        ))}
      </div>

      {activeTab === 'work-orders' && (
        <WorkOrdersTab workOrders={workOrders} vendors={vendors} properties={properties} crew={crew} />
      )}
      {activeTab === 'schedules' && (
        <SchedulesTab schedules={schedules} vendors={vendors} properties={properties} />
      )}
      {activeTab === 'checklists' && (
        <ChecklistsTab
          templates={checklistTemplates}
          onEdit={(id) => setEditTemplateId(id)}
        />
      )}

      {editTemplate && !editTemplate.is_system && (
        <EditTemplateModal
          template={editTemplate}
          onClose={() => setEditTemplateId(null)}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Work Orders Tab
// ─────────────────────────────────────────────────────────────────────────────

type WOView = 'kanban' | 'list'

function WorkOrdersTab({
  workOrders, vendors, properties, crew,
}: {
  workOrders: WorkOrder[]
  vendors:    Vendor[]
  properties: Property[]
  crew:       CrewMember[]
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [view, setView]             = useState<WOView>('kanban')
  const [selectedWO, setSelectedWO] = useState<WorkOrder | null>(null)

  const statusGroups = useMemo(() => {
    const order = ['pending', 'quote_requested', 'assigned', 'in_progress', 'completed', 'cancelled']
    const groups: Record<string, WorkOrder[]> = {}
    for (const s of order) groups[s] = []
    for (const wo of workOrders) {
      const s = wo.wo_status ?? 'pending'
      if (groups[s]) groups[s].push(wo)
    }
    return { order, groups }
  }, [workOrders])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-primary-themed">
            Work Orders
            <span className="ml-2 badge badge-slate">{workOrders.length}</span>
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-raised)' }}>
            <button
              onClick={() => setView('kanban')}
              className="p-1.5 rounded-md transition-colors"
              style={view === 'kanban' ? { background: 'var(--bg-card)', color: 'var(--text-primary)' } : { color: 'var(--text-muted)' }}
              title="Kanban view"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setView('list')}
              className="p-1.5 rounded-md transition-colors"
              style={view === 'list' ? { background: 'var(--bg-card)', color: 'var(--text-primary)' } : { color: 'var(--text-muted)' }}
              title="List view"
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>
          <button onClick={() => setShowCreate(!showCreate)} className="btn-primary text-sm">
            <Plus className="w-4 h-4" />
            New WO
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateWOForm
          vendors={vendors}
          properties={properties}
          crew={crew}
          onClose={() => setShowCreate(false)}
        />
      )}

      {view === 'kanban' ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {statusGroups.order.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              orders={statusGroups.groups[status] ?? []}
              vendors={vendors}
              properties={properties}
              onSelect={setSelectedWO}
            />
          ))}
        </div>
      ) : (
        <WOListView
          statusGroups={statusGroups}
          vendors={vendors}
          properties={properties}
          onSelect={setSelectedWO}
        />
      )}

      {selectedWO && (
        <WODetailModal
          wo={selectedWO}
          vendors={vendors}
          properties={properties}
          crew={crew}
          onClose={() => setSelectedWO(null)}
        />
      )}
    </div>
  )
}

function KanbanColumn({
  status, orders, vendors, properties, onSelect,
}: {
  status:     string
  orders:     WorkOrder[]
  vendors:    Vendor[]
  properties: Property[]
  onSelect:   (wo: WorkOrder) => void
}) {
  const label = WO_STATUS_LABELS[status as keyof typeof WO_STATUS_LABELS] ?? status
  const colors: Record<string, string> = {
    pending:         'var(--text-muted)',
    quote_requested: 'var(--accent-amber)',
    assigned:        'var(--accent-gold)',
    in_progress:     'var(--accent-blue)',
    completed:       'var(--accent-green)',
    cancelled:       'var(--text-muted)',
  }

  return (
    <div className="flex-shrink-0 w-72">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full" style={{ background: colors[status] ?? 'var(--text-muted)' }} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-themed">{label}</span>
        <span className="badge badge-slate ml-auto">{orders.length}</span>
      </div>
      <div className="space-y-2">
        {orders.map((wo) => (
          <WOCard key={wo.id} wo={wo} vendors={vendors} properties={properties} onSelect={onSelect} />
        ))}
        {orders.length === 0 && (
          <div className="rounded-xl border border-dashed border-themed p-4 text-center text-xs text-muted-themed">
            No {label.toLowerCase()} orders
          </div>
        )}
      </div>
    </div>
  )
}

function WOCard({
  wo, vendors, properties, onSelect,
}: {
  wo:         WorkOrder
  vendors:    Vendor[]
  properties: Property[]
  onSelect:   (wo: WorkOrder) => void
}) {
  const vendor   = vendors.find((v) => v.id === wo.assigned_vendor_id)
  const property = properties.find((p) => p.id === wo.property_id)

  return (
    <div
      className="card p-3 cursor-pointer hover:shadow-card-lg transition-shadow"
      onClick={() => onSelect(wo)}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-xs font-mono text-muted-themed">#{wo.wo_number ?? '—'}</span>
        <span
          className="text-xs font-semibold"
          style={{ color: PRIORITY_COLORS[wo.priority_level ?? 'medium'] }}
        >
          {PRIORITY_LABELS[wo.priority_level ?? 'medium']}
        </span>
      </div>
      <p className="text-sm font-medium text-primary-themed leading-snug mb-2">{wo.title}</p>
      <div className="flex items-center justify-between text-xs text-muted-themed">
        <span>{property?.name ?? '—'}</span>
        <span className="badge badge-slate">{WO_CATEGORY_LABELS[wo.wo_category ?? 'general']}</span>
      </div>
      {vendor && (
        <div className="mt-2 text-xs text-muted-themed flex items-center gap-1">
          <User className="w-3 h-3" />
          {vendor.name}
        </div>
      )}
    </div>
  )
}

function WOListView({
  statusGroups, vendors, properties, onSelect,
}: {
  statusGroups: { order: string[]; groups: Record<string, WorkOrder[]> }
  vendors:      Vendor[]
  properties:   Property[]
  onSelect:     (wo: WorkOrder) => void
}) {
  const allWOs = statusGroups.order.flatMap((s) => statusGroups.groups[s] ?? [])

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-themed">
              {['#', 'Title', 'Property', 'Category', 'Priority', 'Status', 'Vendor', ''].map((h) => (
                <th key={h} className="py-2 pr-4 text-left font-medium text-muted-themed text-xs uppercase tracking-wide">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-themed">
            {allWOs.map((wo) => {
              const vendor   = vendors.find((v) => v.id === wo.assigned_vendor_id)
              const property = properties.find((p) => p.id === wo.property_id)
              return (
                <tr
                  key={wo.id}
                  className="hover:bg-raised-themed cursor-pointer transition-colors"
                  onClick={() => onSelect(wo)}
                >
                  <td className="py-2.5 pr-4 font-mono text-xs text-muted-themed">#{wo.wo_number ?? '—'}</td>
                  <td className="py-2.5 pr-4 font-medium text-primary-themed max-w-[200px] truncate">{wo.title}</td>
                  <td className="py-2.5 pr-4 text-secondary-themed">{property?.name ?? '—'}</td>
                  <td className="py-2.5 pr-4">
                    <span className="badge badge-slate">{WO_CATEGORY_LABELS[wo.wo_category ?? 'general']}</span>
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="text-xs font-semibold" style={{ color: PRIORITY_COLORS[wo.priority_level ?? 'medium'] }}>
                      {PRIORITY_LABELS[wo.priority_level ?? 'medium']}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="badge badge-slate">
                      {WO_STATUS_LABELS[wo.wo_status as keyof typeof WO_STATUS_LABELS] ?? wo.wo_status}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-secondary-themed">{vendor?.name ?? '—'}</td>
                  <td className="py-2.5 text-right">
                    <ChevronRight className="w-4 h-4 inline text-muted-themed" />
                  </td>
                </tr>
              )
            })}
            {allWOs.length === 0 && (
              <tr>
                <td colSpan={8} className="py-12 text-center text-sm text-muted-themed">
                  No work orders yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// WO Detail Modal
// ─────────────────────────────────────────────────────────────────────────────

function WODetailModal({
  wo, vendors, properties, crew, onClose,
}: {
  wo:         WorkOrder
  vendors:    Vendor[]
  properties: Property[]
  crew:       CrewMember[]
  onClose:    () => void
}) {
  const vendor   = vendors.find((v) => v.id === wo.assigned_vendor_id)
  const property = properties.find((p) => p.id === wo.property_id)

  const [showStatusForm, setShowStatusForm] = useState(false)
  const [newStatus, setNewStatus]           = useState(wo.wo_status ?? 'pending')
  const [statusNote, setStatusNote]         = useState('')
  const [updatingStatus, startStatusUpdate] = useTransition()

  function handleStatusUpdate() {
    startStatusUpdate(async () => {
      await updateWorkOrderStatus(wo.id, newStatus, statusNote || undefined)
      onClose()
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-card-lg overflow-y-auto max-h-[90vh]"
        style={{ background: 'var(--bg-card)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-themed">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-muted-themed">#{wo.wo_number ?? '—'}</span>
              <span className="badge badge-slate">{WO_CATEGORY_LABELS[wo.wo_category ?? 'general']}</span>
              <span
                className="text-xs font-semibold"
                style={{ color: PRIORITY_COLORS[wo.priority_level ?? 'medium'] }}
              >
                {PRIORITY_LABELS[wo.priority_level ?? 'medium']}
              </span>
            </div>
            <h2 className="text-base font-semibold text-primary-themed">{wo.title}</h2>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-themed text-xs mb-0.5">Property</p>
              <p className="text-secondary-themed">{property?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-muted-themed text-xs mb-0.5">Status</p>
              <span className="badge badge-slate">
                {WO_STATUS_LABELS[wo.wo_status as keyof typeof WO_STATUS_LABELS] ?? wo.wo_status}
              </span>
            </div>
            {vendor && (
              <div>
                <p className="text-muted-themed text-xs mb-0.5">Assigned Vendor</p>
                <p className="text-secondary-themed">{vendor.name}</p>
              </div>
            )}
            {wo.scheduled_date && (
              <div>
                <p className="text-muted-themed text-xs mb-0.5">Scheduled</p>
                <p className="text-secondary-themed">{formatDate(wo.scheduled_date)}</p>
              </div>
            )}
            {wo.estimated_cost != null && (
              <div>
                <p className="text-muted-themed text-xs mb-0.5">Est. Cost</p>
                <p className="text-secondary-themed">${wo.estimated_cost.toLocaleString()}</p>
              </div>
            )}
            {wo.actual_cost != null && (
              <div>
                <p className="text-muted-themed text-xs mb-0.5">Actual Cost</p>
                <p className="text-secondary-themed font-semibold">${wo.actual_cost.toLocaleString()}</p>
              </div>
            )}
          </div>

          {wo.description && (
            <div>
              <p className="text-muted-themed text-xs mb-1">Description</p>
              <p className="text-sm text-secondary-themed whitespace-pre-wrap">{wo.description}</p>
            </div>
          )}

          {/* View full detail link */}
          <Link
            href={`/maintenance/work-orders/${wo.id}`}
            className="btn-secondary text-sm w-full flex items-center justify-center gap-2"
          >
            <Wrench className="w-4 h-4" />
            Open Full Detail
          </Link>

          {/* Status update */}
          <div className="border-t border-themed pt-4">
            <button
              onClick={() => setShowStatusForm(!showStatusForm)}
              className="text-sm text-muted-themed flex items-center gap-1 hover:text-primary-themed transition-colors"
            >
              <ChevronDown className={cn('w-4 h-4 transition-transform', showStatusForm && 'rotate-180')} />
              Update Status
            </button>

            {showStatusForm && (
              <div className="mt-3 space-y-3">
                <select
                  value={newStatus}
                  onChange={(e) => setNewStatus(e.target.value)}
                  className="input text-sm"
                >
                  {Object.entries(WO_STATUS_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
                <textarea
                  value={statusNote}
                  onChange={(e) => setStatusNote(e.target.value)}
                  placeholder="Add a note (optional)"
                  className="input text-sm h-20 resize-none"
                />
                <button
                  onClick={handleStatusUpdate}
                  disabled={updatingStatus}
                  className="btn-primary text-sm w-full"
                >
                  {updatingStatus ? 'Updating…' : 'Save Status'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Create WO Form
// ─────────────────────────────────────────────────────────────────────────────

function CreateWOForm({
  vendors, properties, crew, onClose,
}: {
  vendors:    Vendor[]
  properties: Property[]
  crew:       CrewMember[]
  onClose:    () => void
}) {
  const [state, formAction, pending] = useActionState(createWorkOrder, null)

  if (state?.success) { onClose(); return null }

  return (
    <div className="card p-5 border-themed space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary-themed">New Work Order</h3>
        <button onClick={onClose} className="btn-ghost p-1"><X className="w-4 h-4" /></button>
      </div>

      {state?.error && (
        <div className="text-sm rounded-lg px-3 py-2"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-3">
        <div>
          <label className="label">Title <span className="text-red-400">*</span></label>
          <input name="title" required className="input" placeholder="e.g. Fix leaking faucet" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Property <span className="text-red-400">*</span></label>
            <select name="property_id" required className="input">
              <option value="">Select property…</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Category</label>
            <select name="wo_category" className="input" defaultValue="general">
              {Object.entries(WO_CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Priority</label>
            <select name="priority_level" className="input" defaultValue="medium">
              {Object.entries(PRIORITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Scheduled Date</label>
            <input name="scheduled_date" type="date" className="input" />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Assigned Vendor</label>
            <select name="assigned_vendor_id" className="input">
              <option value="">None</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Est. Cost ($)</label>
            <input name="estimated_cost" type="number" step="0.01" min="0" className="input" placeholder="0.00" />
          </div>
        </div>

        <div>
          <label className="label">Description</label>
          <textarea name="description" className="input h-24 resize-none" placeholder="Describe the issue…" />
        </div>

        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={pending} className="btn-primary text-sm">
            {pending ? 'Creating…' : 'Create Work Order'}
          </button>
          <button type="button" onClick={onClose} className="btn-ghost text-sm">Cancel</button>
        </div>
      </form>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedules Tab
// ─────────────────────────────────────────────────────────────────────────────

function SchedulesTab({
  schedules, vendors, properties,
}: {
  schedules:  MaintenanceSchedule[]
  vendors:    Vendor[]
  properties: Property[]
}) {
  const [showCreate, setShowCreate]   = useState(false)
  const [editSchedule, setEdit]       = useState<MaintenanceSchedule | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-base font-semibold text-primary-themed">
          Maintenance Schedules
          <span className="ml-2 badge badge-slate">{schedules.length}</span>
        </h2>
        <button onClick={() => setShowCreate(!showCreate)} className="btn-primary text-sm">
          <Plus className="w-4 h-4" />
          Add Schedule
        </button>
      </div>

      {showCreate && (
        <ScheduleForm
          vendors={vendors}
          properties={properties}
          onClose={() => setShowCreate(false)}
        />
      )}

      {schedules.length === 0 && !showCreate ? (
        <div className="card py-12 text-center">
          <Calendar className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm text-muted-themed">No maintenance schedules yet.</p>
          <p className="text-xs text-muted-themed mt-1">Add recurring tasks to stay ahead of issues.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <ScheduleCard
              key={s.id}
              schedule={s}
              vendors={vendors}
              properties={properties}
              onEdit={() => setEdit(s)}
            />
          ))}
        </div>
      )}

      {editSchedule && (
        <ScheduleEditModal
          schedule={editSchedule}
          vendors={vendors}
          properties={properties}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  )
}

function ScheduleCard({
  schedule, vendors, properties, onEdit,
}: {
  schedule:   MaintenanceSchedule
  vendors:    Vendor[]
  properties: Property[]
  onEdit:     () => void
}) {
  const vendor   = vendors.find((v) => v.id === schedule.assigned_vendor_id)
  const property = properties.find((p) => p.id === schedule.property_id)
  const [deleting, startDelete] = useTransition()

  return (
    <div className="card p-4 flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <p className="text-sm font-medium text-primary-themed">{schedule.name}</p>
          <span className="badge badge-slate">{FREQ_LABELS[schedule.frequency ?? 'annual'] ?? schedule.frequency}</span>
          {!schedule.is_active && <span className="badge" style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}>Inactive</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-themed flex-wrap">
          {property && <span>{property.name}</span>}
          {vendor && <span className="flex items-center gap-1"><User className="w-3 h-3" />{vendor.name}</span>}
          {schedule.next_due_date && (
            <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />Due {formatDate(schedule.next_due_date)}</span>
          )}
          {schedule.estimated_cost != null && (
            <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" />${schedule.estimated_cost.toLocaleString()}</span>
          )}
        </div>
        {schedule.description && (
          <p className="text-xs text-muted-themed mt-1 truncate">{schedule.description}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button onClick={onEdit} className="btn-ghost py-1 px-2 text-xs" title="Edit">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => startDelete(async () => { await deleteMaintenanceSchedule(schedule.id) })}
          disabled={deleting}
          className="btn-danger py-1 px-2 text-xs"
          title="Delete"
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule Form (Create)
// ─────────────────────────────────────────────────────────────────────────────

function ScheduleForm({
  vendors, properties, onClose,
}: {
  vendors:    Vendor[]
  properties: Property[]
  onClose:    () => void
}) {
  const [state, formAction, pending] = useActionState(addMaintenanceSchedule, null)

  if (state?.success) { onClose(); return null }

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary-themed">New Maintenance Schedule</h3>
        <button onClick={onClose} className="btn-ghost p-1"><X className="w-4 h-4" /></button>
      </div>

      {state?.error && (
        <div className="text-sm rounded-lg px-3 py-2"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-3">
        <div>
          <label className="label">Name <span className="text-red-400">*</span></label>
          <input name="name" required className="input" placeholder="e.g. HVAC Filter Replacement" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Property <span className="text-red-400">*</span></label>
            <select name="property_id" required className="input">
              <option value="">Select property…</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Frequency</label>
            <select name="frequency" className="input" defaultValue="annual">
              {Object.entries(FREQ_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Assigned Vendor</label>
            <select name="assigned_vendor_id" className="input">
              <option value="">None</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Est. Cost ($)</label>
            <input name="estimated_cost" type="number" step="0.01" min="0" className="input" placeholder="0.00" />
          </div>
        </div>

        <div>
          <label className="label">Next Due Date</label>
          <input name="next_due_date" type="date" className="input" />
        </div>

        <div>
          <label className="label">Description / Instructions</label>
          <textarea name="description" className="input h-20 resize-none" />
        </div>

        <div className="flex items-center gap-2">
          <input name="auto_create_wo" type="checkbox" id="auto_wo" defaultChecked className="rounded" />
          <label htmlFor="auto_wo" className="text-sm text-secondary-themed">Auto-create work order when due</label>
        </div>

        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={pending} className="btn-primary text-sm">
            {pending ? 'Saving…' : 'Save Schedule'}
          </button>
          <button type="button" onClick={onClose} className="btn-ghost text-sm">Cancel</button>
        </div>
      </form>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule Edit Modal
// ─────────────────────────────────────────────────────────────────────────────

function ScheduleEditModal({
  schedule, vendors, properties, onClose,
}: {
  schedule:   MaintenanceSchedule
  vendors:    Vendor[]
  properties: Property[]
  onClose:    () => void
}) {
  const [state, formAction, pending] = useActionState(updateMaintenanceSchedule, null)

  if (state?.success) { onClose(); return null }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-card-lg overflow-y-auto max-h-[90vh]"
        style={{ background: 'var(--bg-card)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-themed">
          <h3 className="text-sm font-semibold text-primary-themed">Edit Schedule</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5">
          {state?.error && (
            <div className="text-sm rounded-lg px-3 py-2 mb-4"
                 style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
              {state.error}
            </div>
          )}

          <form action={formAction} className="space-y-3">
            <input type="hidden" name="id" value={schedule.id} />

            <div>
              <label className="label">Name</label>
              <input name="name" defaultValue={schedule.name} className="input" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Property</label>
                <select name="property_id" defaultValue={schedule.property_id ?? ''} className="input">
                  <option value="">Select property…</option>
                  {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Frequency</label>
                <select name="frequency" defaultValue={schedule.frequency ?? 'annual'} className="input">
                  {Object.entries(FREQ_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Assigned Vendor</label>
                <select name="assigned_vendor_id" defaultValue={schedule.assigned_vendor_id ?? ''} className="input">
                  <option value="">None</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Est. Cost ($)</label>
                <input
                  name="estimated_cost"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={schedule.estimated_cost ?? ''}
                  className="input"
                />
              </div>
            </div>

            <div>
              <label className="label">Next Due Date</label>
              <input
                name="next_due_date"
                type="date"
                defaultValue={schedule.next_due_date ?? ''}
                className="input"
              />
            </div>

            <div>
              <label className="label">Description / Instructions</label>
              <textarea
                name="description"
                defaultValue={schedule.description ?? ''}
                className="input h-20 resize-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                name="auto_create_wo"
                type="checkbox"
                id="edit_auto_wo"
                defaultChecked={schedule.auto_create_wo ?? true}
                className="rounded"
              />
              <label htmlFor="edit_auto_wo" className="text-sm text-secondary-themed">
                Auto-create work order when due
              </label>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                name="is_active"
                type="checkbox"
                id="edit_is_active"
                defaultChecked={schedule.is_active ?? true}
                className="rounded"
              />
              <label htmlFor="edit_is_active" className="text-sm text-secondary-themed">Active</label>
            </div>

            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={pending} className="btn-primary text-sm">
                {pending ? 'Saving…' : 'Save Changes'}
              </button>
              <button type="button" onClick={onClose} className="btn-ghost text-sm">Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Checklists Tab
// ─────────────────────────────────────────────────────────────────────────────

function ChecklistsTab({
  templates,
  onEdit,
}: {
  templates: ChecklistTemplate[]
  onEdit:    (id: string) => void
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-base font-semibold text-primary-themed">
          Checklist Templates
          <span className="ml-2 badge badge-slate">{templates.length}</span>
        </h2>
        <Link href="/properties" className="btn-secondary text-sm">
          Manage in Properties
        </Link>
      </div>

      {templates.length === 0 ? (
        <div className="card py-12 text-center">
          <CheckCircle2 className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm text-muted-themed">No checklist templates yet.</p>
          <p className="text-xs text-muted-themed mt-1">Templates are created per property in the Properties setup.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <div key={t.id} className="card p-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: 'var(--accent-gold)' }} />
                <span className="text-sm font-medium text-primary-themed">{t.name}</span>
                {t.is_system && (
                  <span
                    className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{ background: 'var(--bg-raised)', color: 'var(--text-muted)' }}
                    title="System templates are read-only"
                  >
                    FieldStay · Read-only
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!t.is_system && (
                  <button
                    onClick={() => onEdit(t.id)}
                    className="btn-ghost py-1 px-2 text-xs"
                    title="Edit template name"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                <Link
                  href={`/properties?template=${t.id}`}
                  className="btn-secondary text-xs px-3 py-1"
                >
                  View
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
