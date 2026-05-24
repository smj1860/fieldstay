'use client'

import { useState, useTransition, useActionState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus, ChevronDown, X, Wrench, Calendar, DollarSign,
  User, ChevronRight, AlertTriangle, CheckCircle2, Clock
} from 'lucide-react'
import { cn, formatDate, WO_STATUS_LABELS } from '@/lib/utils'
import { createWorkOrder, createWorkOrderFromSchedule } from './actions'
import type { WoStatus, PriorityLevel, VendorSpecialty, ScheduleType, ScheduleFrequency } from '@/types/database'

// ── Local types ───────────────────────────────────────────────────────────────

interface WorkOrderRow {
  id: string
  property_id: string
  vendor_id: string | null
  title: string
  description: string | null
  priority: PriorityLevel
  status: WoStatus
  scheduled_date: string | null
  completed_date: string | null
  estimated_cost: number | null
  actual_cost: number | null
  portal_enabled: boolean
  completion_notes: string | null
  created_at: string
  properties: { name: string } | { name: string }[] | null
  vendors: { name: string } | { name: string }[] | null
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

interface ScheduleRow {
  id: string
  property_id: string
  name: string
  description: string | null
  schedule_type: ScheduleType
  frequency: ScheduleFrequency | null
  next_due_date: string | null
  last_completed_date: string | null
  estimated_cost: number | null
  auto_create_wo: boolean
  assigned_vendor_id: string | null
  properties: { name: string } | { name: string }[] | null
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
    pending:     'badge badge-slate',
    assigned:    'badge badge-blue',
    in_progress: 'badge badge-amber',
    completed:   'badge badge-green',
    cancelled:   'badge badge-slate',
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

const STATUS_TABS = [
  { key: 'all',         label: 'All' },
  { key: 'pending',     label: 'Pending' },
  { key: 'assigned',    label: 'Assigned' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed',   label: 'Completed' },
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
        'bg-white rounded-xl border border-accent-200 p-4 cursor-pointer',
        'hover:shadow-[0_2px_8px_0_rgba(0,0,0,.08)] hover:border-accent-300 transition-all',
        wo.priority === 'urgent' && 'border-l-4 border-l-red-400',
        wo.priority === 'high'   && 'border-l-4 border-l-amber-400',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {/* Title + badges */}
          <div className="flex items-start gap-2 flex-wrap">
            <span className="font-semibold text-accent-900 text-sm leading-snug flex-1 min-w-0 truncate">
              {wo.title}
            </span>
            <span className={priorityBadgeClass(wo.priority)}>
              {PRIORITY_LABELS[wo.priority]}
            </span>
            <span className={statusBadgeClass(wo.status)}>
              {WO_STATUS_LABELS[wo.status]}
            </span>
          </div>

          {/* Property + vendor */}
          <div className="flex items-center gap-3 mt-1.5 text-xs text-accent-500 flex-wrap">
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
            {wo.estimated_cost != null && (
              <span className="flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                {wo.estimated_cost.toFixed(0)}
              </span>
            )}
          </div>
        </div>

        <ChevronRight className="w-4 h-4 text-accent-300 flex-shrink-0 mt-0.5" />
      </div>
    </div>
  )
}

// ── Create Work Order Modal ───────────────────────────────────────────────────

function CreateWorkOrderModal({
  properties,
  vendors,
  onClose,
}: {
  properties: PropertyOption[]
  vendors: VendorOption[]
  onClose: () => void
}) {
  const [state, action, pending] = useActionState(createWorkOrder, null)
  const [selectedVendor, setSelectedVendor] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-[0_8px_32px_0_rgba(0,0,0,.16)] w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-accent-900">New Work Order</h3>
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
              rows={3}
              className="input resize-none"
              placeholder="Details about the issue or task…"
            />
          </div>

          {/* Priority + Vendor */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="wo-priority" className="label">Priority</label>
              <select id="wo-priority" name="priority" defaultValue="medium" className="input">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label htmlFor="wo-vendor" className="label">Vendor (optional)</label>
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
            </div>
          </div>

          {/* Scheduled date + cost */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="wo-date" className="label">Scheduled Date</label>
              <input id="wo-date" name="scheduled_date" type="date" className="input" />
            </div>
            <div>
              <label htmlFor="wo-cost" className="label">Est. Cost ($)</label>
              <input
                id="wo-cost"
                name="estimated_cost"
                type="number"
                min="0"
                step="0.01"
                className="input"
                placeholder="0.00"
              />
            </div>
          </div>

          {/* Portal enabled */}
          {selectedVendor && (
            <label className="flex items-center gap-2 text-sm text-accent-700 cursor-pointer">
              <input
                type="checkbox"
                name="portal_enabled"
                defaultChecked
                className="w-4 h-4 rounded border-accent-300 text-brand-600 focus:ring-brand-500"
              />
              Send vendor portal link (vendor can mark complete via link)
            </label>
          )}

          <div className="flex gap-3 pt-2 border-t border-accent-100">
            <button type="submit" disabled={pending} className="btn-primary flex-1">
              {pending ? 'Creating…' : 'Create Work Order'}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Schedules Section ─────────────────────────────────────────────────────────

function SchedulesSection({ schedules }: { schedules: ScheduleRow[] }) {
  const [open, setOpen] = useState(false)
  const [creating, startCreate] = useTransition()
  const [creatingId, setCreatingId] = useState<string | null>(null)

  const handleCreateWO = (scheduleId: string) => {
    setCreatingId(scheduleId)
    startCreate(async () => {
      await createWorkOrderFromSchedule(scheduleId)
      setCreatingId(null)
    })
  }

  if (!schedules.length) return null

  return (
    <div className="mt-8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left group mb-1"
      >
        <span className="text-sm font-semibold text-accent-700 group-hover:text-accent-900 transition-colors">
          Maintenance Schedules
        </span>
        <span className="badge badge-slate">{schedules.length}</span>
        <ChevronDown className={cn(
          'w-4 h-4 text-accent-400 ml-auto transition-transform',
          open && 'rotate-180'
        )} />
      </button>
      <p className="text-xs text-accent-400 mb-3">Recurring tasks that generate work orders automatically</p>

      {open && (
        <div className="overflow-x-auto rounded-xl border border-accent-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-accent-100 bg-accent-50">
                <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">Name</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">Property</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">Frequency</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">Next Due</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">Last Done</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-accent-500 uppercase tracking-wide">Auto</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-accent-100">
              {schedules.map((s) => {
                const property = getJoined(s.properties)
                const isOverdue = s.next_due_date && new Date(s.next_due_date) < new Date()
                return (
                  <tr key={s.id} className="hover:bg-accent-50 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-medium text-accent-900">{s.name}</span>
                      {s.description && (
                        <p className="text-xs text-accent-400 mt-0.5 truncate max-w-[200px]">{s.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-accent-600">{property?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-accent-600">
                      {s.frequency ? FREQUENCY_LABELS[s.frequency] ?? s.frequency : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {s.next_due_date ? (
                        <span className={cn(
                          'flex items-center gap-1',
                          isOverdue ? 'text-red-600 font-medium' : 'text-accent-600'
                        )}>
                          {isOverdue && <AlertTriangle className="w-3 h-3" />}
                          {formatDate(s.next_due_date)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-accent-600">
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
                      <button
                        onClick={() => handleCreateWO(s.id)}
                        disabled={creating && creatingId === s.id}
                        className="btn-secondary text-xs py-1.5 px-3 whitespace-nowrap"
                      >
                        {creating && creatingId === s.id ? (
                          <Clock className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                        Create WO
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Main Board ────────────────────────────────────────────────────────────────

export function MaintenanceBoard({
  workOrders,
  properties,
  vendors,
  schedules,
}: {
  workOrders: WorkOrderRow[]
  properties: PropertyOption[]
  vendors: VendorOption[]
  schedules: ScheduleRow[]
}) {
  const router = useRouter()
  const [showCreate, setShowCreate] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('all')
  const [filterProperty, setFilterProperty] = useState<string>('all')
  const [filterPriority, setFilterPriority] = useState<string>('all')

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
      <div className="flex items-center gap-1 bg-white border border-accent-200 rounded-lg px-1 py-1 w-fit mb-4">
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
                  : 'text-accent-500 hover:text-accent-700'
              )}
            >
              {tab.label}
              <span className={cn(
                'px-1.5 py-0.5 rounded-full text-xs font-semibold',
                activeTab === tab.key ? 'bg-brand-700 text-brand-100' : 'bg-accent-100 text-accent-500'
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
            className="btn-ghost text-xs py-1.5 text-accent-400"
          >
            <X className="w-3 h-3" /> Clear filters
          </button>
        )}
      </div>

      {/* Work Orders List */}
      {filtered.length === 0 ? (
        <div className="card text-center py-16 max-w-md mx-auto mt-4">
          <Wrench className="w-10 h-10 text-accent-300 mx-auto mb-3" />
          <h3 className="font-semibold text-accent-700 mb-1">No work orders found</h3>
          <p className="text-sm text-accent-400 mb-4">
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
          {filtered.map((wo) => (
            <WorkOrderCard
              key={wo.id}
              wo={wo}
              onClick={() => router.push(`/maintenance/${wo.id}`)}
            />
          ))}
        </div>
      )}

      {/* Maintenance Schedules */}
      <SchedulesSection schedules={schedules} />

      {/* Create Modal */}
      {showCreate && (
        <CreateWorkOrderModal
          properties={properties}
          vendors={vendors}
          onClose={() => setShowCreate(false)}
        />
      )}
    </>
  )
}
