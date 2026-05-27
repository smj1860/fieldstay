'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Calendar, DollarSign, User, Wrench, Clock,
  CheckCircle2, AlertTriangle, XCircle, ArrowRight,
  ExternalLink, Trash2, Pencil
} from 'lucide-react'
import { cn, formatDate, formatDateTime, WO_STATUS_LABELS } from '@/lib/utils'
import { updateWorkOrderStatus, deleteWorkOrder, updateWorkOrder, addWorkOrderNote } from '../actions'
import type { WoStatus, PriorityLevel } from '@/types/database'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkOrderDetailProps {
  id: string
  property_id: string
  vendor_id: string | null
  title: string
  description: string | null
  priority: PriorityLevel
  status: WoStatus
  source: string
  scheduled_date: string | null
  completed_date: string | null
  estimated_cost: number | null
  actual_cost: number | null
  portal_enabled: boolean
  completion_token: string | null
  completion_notes: string | null
  invoice_reference: string | null
  created_at: string
  updated_at: string
  properties: { id: string; name: string; city: string | null; state: string | null } | null
  vendors: { id: string; name: string; specialty: string; email: string | null; phone: string | null } | null
}

interface WorkOrderUpdate {
  id: string
  status_from: WoStatus | null
  status_to: WoStatus | null
  notes: string | null
  updated_via_vendor_portal: boolean
  created_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function priorityBadgeClass(priority: PriorityLevel) {
  const map: Record<PriorityLevel, string> = {
    low:    'badge badge-slate',
    medium: 'badge badge-blue',
    high:   'badge badge-amber',
    urgent: 'badge badge-red',
  }
  return map[priority]
}

function statusBadgeClass(status: WoStatus) {
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

const SOURCE_LABELS: Record<string, string> = {
  manual:               'Manual',
  maintenance_schedule: 'Maintenance Schedule',
  crew_flag:            'Crew Flag',
  guest_report:         'Guest Report',
}

/** Returns the valid next status transitions from a given status */
function nextStatuses(status: WoStatus): WoStatus[] {
  switch (status) {
    case 'pending':     return ['assigned', 'in_progress', 'cancelled']
    case 'assigned':    return ['in_progress', 'completed', 'cancelled']
    case 'in_progress': return ['completed', 'cancelled']
    case 'completed':   return []
    case 'cancelled':   return ['pending']
    default:            return []
  }
}

// ── Status Update Controls ────────────────────────────────────────────────────

function StatusControls({
  workOrderId,
  currentStatus,
}: {
  workOrderId: string
  currentStatus: WoStatus
}) {
  const [updating, startUpdate] = useTransition()
  const [notes, setNotes] = useState('')
  const [showNotes, setShowNotes] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<WoStatus | null>(null)

  const transitions = nextStatuses(currentStatus)
  if (!transitions.length) return null

  const handleStatusClick = (status: WoStatus) => {
    if (status === 'completed') {
      setPendingStatus(status)
      setShowNotes(true)
    } else {
      startUpdate(async () => {
        await updateWorkOrderStatus(workOrderId, status)
      })
    }
  }

  const handleConfirmComplete = () => {
    if (!pendingStatus) return
    setShowNotes(false)
    startUpdate(async () => {
      await updateWorkOrderStatus(workOrderId, pendingStatus, notes || undefined)
      setNotes('')
      setPendingStatus(null)
    })
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-accent-700">Update Status</h3>

      {showNotes && pendingStatus === 'completed' ? (
        <div className="space-y-2 p-3 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm font-medium text-green-800">Mark as Complete</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="input text-sm resize-none"
            placeholder="Completion notes (optional)…"
          />
          <div className="flex gap-2">
            <button
              onClick={handleConfirmComplete}
              disabled={updating}
              className="text-sm px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 font-medium flex items-center gap-1.5 disabled:opacity-50 transition-colors"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {updating ? 'Saving…' : 'Confirm Complete'}
            </button>
            <button
              onClick={() => { setShowNotes(false); setPendingStatus(null) }}
              className="btn-ghost text-sm py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          {transitions.map((status) => (
            <button
              key={status}
              onClick={() => handleStatusClick(status)}
              disabled={updating}
              className={cn(
                'text-sm px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50',
                status === 'completed'
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : status === 'cancelled'
                  ? 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                  : 'btn-secondary'
              )}
            >
              {status === 'completed' && <CheckCircle2 className="w-3.5 h-3.5" />}
              {status === 'cancelled' && <XCircle className="w-3.5 h-3.5" />}
              {WO_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Cancel / Delete ───────────────────────────────────────────────────────────

function DeleteControl({ workOrderId, status }: { workOrderId: string; status: WoStatus }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, startDelete] = useTransition()

  if (status === 'cancelled') return null

  return (
    <div>
      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="btn-ghost text-xs text-red-500 hover:text-red-700 hover:bg-red-50 py-1.5"
        >
          <Trash2 className="w-3 h-3" />
          Cancel Work Order
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <p className="text-xs text-accent-500">Cancel this work order?</p>
          <button
            onClick={() => startDelete(() => deleteWorkOrder(workOrderId))}
            disabled={deleting}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 font-medium disabled:opacity-50 transition-colors"
          >
            {deleting ? 'Cancelling…' : 'Yes, cancel'}
          </button>
          <button onClick={() => setConfirming(false)} className="btn-ghost text-xs py-1.5">
            Never mind
          </button>
        </div>
      )}
    </div>
  )
}

// ── Status Timeline ───────────────────────────────────────────────────────────

function StatusTimeline({ updates }: { updates: WorkOrderUpdate[] }) {
  if (!updates.length) return null

  return (
    <div>
      <h3 className="text-sm font-semibold text-accent-700 mb-3">Status History</h3>
      <div className="space-y-2">
        {updates.map((u) => (
          <div key={u.id} className="flex items-start gap-3 text-sm">
            <div className="w-2 h-2 rounded-full bg-brand-400 mt-1.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {u.status_from && (
                  <>
                    <span className="badge badge-slate text-xs">{WO_STATUS_LABELS[u.status_from]}</span>
                    <ArrowRight className="w-3 h-3 text-accent-400" />
                  </>
                )}
                {u.status_to && (
                  <span className={cn('badge text-xs', {
                    'badge-slate': u.status_to === 'pending' || u.status_to === 'cancelled',
                    'badge-blue': u.status_to === 'assigned',
                    'badge-amber': u.status_to === 'in_progress',
                    'badge-green': u.status_to === 'completed',
                  })}>
                    {WO_STATUS_LABELS[u.status_to]}
                  </span>
                )}
                {u.updated_via_vendor_portal && (
                  <span className="badge badge-blue text-xs">via vendor portal</span>
                )}
                <span className="text-xs text-accent-400 ml-auto">{formatDateTime(u.created_at)}</span>
              </div>
              {u.notes && (
                <p className="text-xs text-accent-500 mt-0.5 italic">{u.notes}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function WorkOrderDetail({
  workOrder,
  updates,
  vendors = [],
}: {
  workOrder: WorkOrderDetailProps
  updates: WorkOrderUpdate[]
  vendors?: { id: string; name: string; specialty: string }[]
}) {
  const property = Array.isArray(workOrder.properties)
    ? workOrder.properties[0]
    : workOrder.properties

  const vendor = Array.isArray(workOrder.vendors)
    ? workOrder.vendors[0]
    : workOrder.vendors

  const portalUrl = workOrder.completion_token
    ? `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/work-orders/${workOrder.completion_token}`
    : null

  const [editing, setEditing]     = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [saving, setSaving]       = useState(false)
  const [noteText, setNoteText]   = useState('')
  const [addingNote, setAddingNote] = useState(false)

  const handleEditSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSaving(true)
    setEditError(null)
    const fd = new FormData(e.currentTarget)
    const result = await updateWorkOrder(workOrder.id, {
      title:          fd.get('title') as string,
      description:    (fd.get('description') as string) || null,
      priority:       fd.get('priority') as string,
      vendor_id:      (fd.get('vendor_id') as string) || null,
      scheduled_date: (fd.get('scheduled_date') as string) || null,
      estimated_cost: fd.get('estimated_cost')
        ? parseFloat(fd.get('estimated_cost') as string)
        : null,
      portal_enabled: fd.get('portal_enabled') === 'true',
    })
    setSaving(false)
    if (result.error) { setEditError(result.error); return }
    setEditing(false)
  }

  const handleAddNote = async () => {
    if (!noteText.trim()) return
    setAddingNote(true)
    await addWorkOrderNote(workOrder.id, noteText)
    setNoteText('')
    setAddingNote(false)
  }

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start gap-3 flex-wrap">
          <h1 className="page-title flex-1">{workOrder.title}</h1>
          <span className={priorityBadgeClass(workOrder.priority)}>
            {PRIORITY_LABELS[workOrder.priority]}
          </span>
          <span className={statusBadgeClass(workOrder.status)}>
            {WO_STATUS_LABELS[workOrder.status]}
          </span>
          {!['completed', 'cancelled'].includes(workOrder.status) && (
            <button
              onClick={() => setEditing(!editing)}
              className="btn-secondary text-sm flex items-center gap-1.5"
            >
              <Pencil className="w-3.5 h-3.5" />
              {editing ? 'Close Edit' : 'Edit'}
            </button>
          )}
        </div>
        <p className="page-subtitle mt-1">
          Created {formatDateTime(workOrder.created_at)} &bull; {SOURCE_LABELS[workOrder.source] ?? workOrder.source}
        </p>
      </div>

      {/* Edit form */}
      {editing && (
        <div className="card mb-6">
          <h3 className="section-header mb-4">Edit Work Order</h3>
          {editError && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-3">{editError}</div>
          )}
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <div>
              <label className="label">Title</label>
              <input name="title" type="text" required className="input" defaultValue={workOrder.title} />
            </div>
            <div>
              <label className="label">Description</label>
              <textarea name="description" rows={3} className="input resize-none" defaultValue={workOrder.description ?? ''} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Priority</label>
                <select name="priority" className="input" defaultValue={workOrder.priority}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div>
                <label className="label">Scheduled Date</label>
                <input name="scheduled_date" type="date" className="input" defaultValue={workOrder.scheduled_date ?? ''} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Estimated Cost ($)</label>
                <input name="estimated_cost" type="number" min="0" step="0.01" className="input" defaultValue={workOrder.estimated_cost ?? ''} />
              </div>
              {vendors.length > 0 && (
                <div>
                  <label className="label">Vendor</label>
                  <select name="vendor_id" className="input" defaultValue={workOrder.vendor_id ?? ''}>
                    <option value="">None</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <select name="portal_enabled" className="input w-auto text-sm" defaultValue={workOrder.portal_enabled ? 'true' : 'false'}>
                <option value="false">Portal disabled</option>
                <option value="true">Portal enabled</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={saving} className="btn-primary text-sm">
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <button type="button" onClick={() => setEditing(false)} className="btn-ghost text-sm">Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left — main info */}
        <div className="lg:col-span-2 space-y-6">

          {/* Description */}
          {workOrder.description && (
            <div className="card">
              <h3 className="section-header">Description</h3>
              <p className="text-sm text-accent-700 whitespace-pre-wrap">{workOrder.description}</p>
            </div>
          )}

          {/* Completion notes */}
          {workOrder.completion_notes && (
            <div className="card bg-green-50 border-green-200">
              <h3 className="text-sm font-semibold text-green-700 mb-2 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                Completion Notes
              </h3>
              <p className="text-sm text-green-800 whitespace-pre-wrap">{workOrder.completion_notes}</p>
              {workOrder.completed_date && (
                <p className="text-xs text-green-600 mt-2">Completed: {formatDate(workOrder.completed_date)}</p>
              )}
            </div>
          )}

          {/* Add Note */}
          <div className="card">
            <h3 className="section-header mb-2">Add Note</h3>
            <div className="flex gap-2">
              <textarea
                rows={2}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                className="input resize-none flex-1 text-sm"
                placeholder="Add a note, question for vendor, or update…"
              />
              <button
                onClick={handleAddNote}
                disabled={addingNote || !noteText.trim()}
                className="btn-secondary self-end px-3 py-2 text-sm"
              >
                {addingNote ? '…' : 'Add'}
              </button>
            </div>
          </div>

          {/* Status Controls */}
          {workOrder.status !== 'completed' && (
            <div className="card">
              <StatusControls
                workOrderId={workOrder.id}
                currentStatus={workOrder.status}
              />
            </div>
          )}

          {/* Status Timeline */}
          {updates.length > 0 && (
            <div className="card">
              <StatusTimeline updates={updates} />
            </div>
          )}

          {/* Danger zone */}
          <div>
            <DeleteControl workOrderId={workOrder.id} status={workOrder.status} />
          </div>
        </div>

        {/* Right — metadata */}
        <div className="space-y-4">
          {/* Property */}
          <div className="card">
            <h3 className="section-header">Property</h3>
            {property ? (
              <div>
                <p className="font-medium text-accent-900">{property.name}</p>
                {(property.city || property.state) && (
                  <p className="text-xs text-accent-500 mt-0.5">
                    {[property.city, property.state].filter(Boolean).join(', ')}
                  </p>
                )}
                <Link
                  href={`/properties/${property.id}`}
                  className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1 mt-2"
                >
                  View Property <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            ) : (
              <p className="text-sm text-accent-400">No property linked</p>
            )}
          </div>

          {/* Vendor */}
          {vendor && (
            <div className="card">
              <h3 className="section-header">Vendor</h3>
              <p className="font-medium text-accent-900">{vendor.name}</p>
              <p className="text-xs text-accent-500 capitalize mt-0.5">{vendor.specialty.replace('_', ' ')}</p>
              {vendor.email && (
                <a href={`mailto:${vendor.email}`} className="text-xs text-brand-600 hover:underline mt-1 block">
                  {vendor.email}
                </a>
              )}
              {vendor.phone && (
                <a href={`tel:${vendor.phone}`} className="text-xs text-accent-500 hover:text-accent-700 mt-0.5 block">
                  {vendor.phone}
                </a>
              )}
            </div>
          )}

          {/* Dates & Cost */}
          <div className="card space-y-3">
            <h3 className="section-header">Details</h3>

            {workOrder.scheduled_date && (
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="w-3.5 h-3.5 text-accent-400 flex-shrink-0" />
                <span className="text-accent-500 text-xs w-24 flex-shrink-0">Scheduled</span>
                <span className="text-accent-800 font-medium">{formatDate(workOrder.scheduled_date)}</span>
              </div>
            )}

            {workOrder.completed_date && (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                <span className="text-accent-500 text-xs w-24 flex-shrink-0">Completed</span>
                <span className="text-accent-800 font-medium">{formatDate(workOrder.completed_date)}</span>
              </div>
            )}

            {workOrder.estimated_cost != null && (
              <div className="flex items-center gap-2 text-sm">
                <DollarSign className="w-3.5 h-3.5 text-accent-400 flex-shrink-0" />
                <span className="text-accent-500 text-xs w-24 flex-shrink-0">Est. Cost</span>
                <span className="text-accent-800 font-medium">${workOrder.estimated_cost.toFixed(2)}</span>
              </div>
            )}

            {workOrder.actual_cost != null && (
              <div className="flex items-center gap-2 text-sm">
                <DollarSign className="w-3.5 h-3.5 text-accent-400 flex-shrink-0" />
                <span className="text-accent-500 text-xs w-24 flex-shrink-0">Actual Cost</span>
                <span className="text-accent-800 font-medium">${workOrder.actual_cost.toFixed(2)}</span>
              </div>
            )}

            {workOrder.invoice_reference && (
              <div className="flex items-center gap-2 text-sm">
                <Wrench className="w-3.5 h-3.5 text-accent-400 flex-shrink-0" />
                <span className="text-accent-500 text-xs w-24 flex-shrink-0">Invoice #</span>
                <span className="text-accent-800 font-medium">{workOrder.invoice_reference}</span>
              </div>
            )}

            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-3.5 h-3.5 text-accent-400 flex-shrink-0" />
              <span className="text-accent-500 text-xs w-24 flex-shrink-0">Updated</span>
              <span className="text-accent-700 text-xs">{formatDateTime(workOrder.updated_at)}</span>
            </div>
          </div>

          {/* Vendor Portal Link */}
          {workOrder.portal_enabled && workOrder.completion_token && (
            <div className="card bg-blue-50 border-blue-200">
              <h3 className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-2">
                Vendor Portal
              </h3>
              <p className="text-xs text-blue-600 mb-2">
                Share this link with the vendor to let them mark the work order complete.
              </p>
              <a
                href={`/work-orders/${workOrder.completion_token}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-700 font-medium hover:underline flex items-center gap-1 break-all"
              >
                View portal link <ExternalLink className="w-3 h-3 flex-shrink-0" />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
