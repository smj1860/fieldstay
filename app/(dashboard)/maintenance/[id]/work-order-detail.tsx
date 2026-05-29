'use client'

import { useState, useTransition, useRef } from 'react'
import Link from 'next/link'
import {
  Calendar, DollarSign, User, Wrench, Clock,
  CheckCircle2, AlertTriangle, XCircle, ArrowRight,
  ExternalLink, Trash2, Pencil, Camera, ImageIcon,
  X, Loader2, Receipt, MessageSquareDot,
} from 'lucide-react'
import { cn, formatDate, formatDateTime, WO_STATUS_LABELS } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import {
  updateWorkOrderStatus,
  deleteWorkOrder,
  updateWorkOrder,
  addWorkOrderNote,
  logActualCost,
  recordWorkOrderPhoto,
  deleteWorkOrderPhoto,
  requestVendorQuote,
  approveVendorQuote,
} from '../actions'
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
  source_schedule_id: string | null
  scheduled_date: string | null
  completed_date: string | null
  estimated_cost: number | null
  actual_cost: number | null
  portal_enabled: boolean
  completion_token: string | null
  completion_token_expires_at: string | null
  completion_notes: string | null
  invoice_reference: string | null
  quote_token: string | null
  quote_token_expires_at: string | null
  quoted_amount: number | null
  quote_notes: string | null
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

interface WorkOrderPhoto {
  id: string
  storage_path: string
  uploaded_by: string | null
  caption: string | null
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
    pending:         'badge badge-slate',
    quote_requested: 'badge badge-gold',
    assigned:        'badge badge-blue',
    in_progress:     'badge badge-amber',
    completed:       'badge badge-green',
    cancelled:       'badge badge-slate',
  }
  return map[status] ?? 'badge badge-slate'
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

function nextStatuses(status: WoStatus): WoStatus[] {
  switch (status) {
    case 'pending':         return ['assigned', 'in_progress', 'cancelled']
    case 'quote_requested': return ['assigned', 'cancelled']
    case 'assigned':        return ['in_progress', 'completed', 'cancelled']
    case 'in_progress':     return ['completed', 'cancelled']
    case 'completed':       return []
    case 'cancelled':       return ['pending']
    default:                return []
  }
}

// ── Status Controls ───────────────────────────────────────────────────────────

function StatusControls({ workOrderId, currentStatus }: { workOrderId: string; currentStatus: WoStatus }) {
  const [updating, startUpdate]   = useTransition()
  const [notes, setNotes]         = useState('')
  const [showNotes, setShowNotes] = useState(false)
  const [pending, setPending]     = useState<WoStatus | null>(null)

  const transitions = nextStatuses(currentStatus)
  if (!transitions.length) return null

  const handleClick = (status: WoStatus) => {
    if (status === 'completed') { setPending(status); setShowNotes(true); return }
    startUpdate(async () => { await updateWorkOrderStatus(workOrderId, status) })
  }

  const handleConfirm = () => {
    if (!pending) return
    setShowNotes(false)
    startUpdate(async () => {
      await updateWorkOrderStatus(workOrderId, pending, notes || undefined)
      setNotes('')
      setPending(null)
    })
  }

  return (
    <div className="space-y-3">
      <h3 className="section-header">Update Status</h3>

      {showNotes && pending === 'completed' ? (
        <div className="space-y-2 p-3 rounded-lg" style={{ background: 'var(--accent-green-dim)', border: '1px solid rgba(47,217,140,0.25)' }}>
          <p className="text-sm font-medium" style={{ color: 'var(--accent-green)' }}>Mark as Complete</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="input text-sm resize-none"
            placeholder="Completion notes (optional)…"
          />
          <div className="flex gap-2">
            <button onClick={handleConfirm} disabled={updating}
                    className="text-sm px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 disabled:opacity-50 transition-colors"
                    style={{ background: 'var(--accent-green)', color: '#0a1628' }}>
              <CheckCircle2 className="w-3.5 h-3.5" />
              {updating ? 'Saving…' : 'Confirm Complete'}
            </button>
            <button onClick={() => { setShowNotes(false); setPending(null) }} className="btn-ghost text-sm py-1.5">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          {transitions.map((status) => (
            <button
              key={status}
              onClick={() => handleClick(status)}
              disabled={updating}
              className={cn(
                'text-sm px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50',
                status === 'completed' ? 'text-white' : status === 'cancelled' ? 'btn-danger' : 'btn-secondary'
              )}
              style={status === 'completed' ? { background: 'var(--accent-green)', color: '#0a1628' } : undefined}
            >
              {status === 'completed' && <CheckCircle2 className="w-3.5 h-3.5" />}
              {status === 'cancelled'  && <XCircle className="w-3.5 h-3.5" />}
              {WO_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Feature 5: Quote panel ────────────────────────────────────────────────────

function QuotePanel({ workOrder }: { workOrder: WorkOrderDetailProps }) {
  const [requesting, startRequest] = useTransition()
  const [approving,  startApprove] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  const hasVendor    = !!workOrder.vendor_id
  const isPending    = workOrder.status === 'pending'
  const isQuoted     = workOrder.status === 'quote_requested'
  const hasQuote     = workOrder.quoted_amount != null
  const quoteExpired = workOrder.quote_token_expires_at
    ? new Date(workOrder.quote_token_expires_at) < new Date()
    : false

  const quotePortalUrl = workOrder.quote_token
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/work-orders/${workOrder.quote_token}/quote`
    : null

  if (!isPending && !isQuoted) return null

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3">
        <MessageSquareDot className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
        <h3 className="section-header mb-0">Vendor Quote</h3>
      </div>

      {err && (
        <div className="text-xs rounded px-3 py-2 mb-3"
             style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
          {err}
        </div>
      )}

      {isPending && !isQuoted && (
        <>
          {!hasVendor && (
            <p className="text-xs text-muted-themed mb-3">Assign a vendor first to request a quote.</p>
          )}
          <button
            disabled={!hasVendor || requesting}
            onClick={() => startRequest(async () => {
              const r = await requestVendorQuote(workOrder.id)
              if (r.error) setErr(r.error)
            })}
            className="btn-secondary text-sm"
          >
            {requesting ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</> : 'Request Quote from Vendor'}
          </button>
        </>
      )}

      {isQuoted && (
        <div className="space-y-3">
          {hasQuote ? (
            <div className="p-3 rounded-lg border border-themed" style={{ background: 'var(--bg-raised)' }}>
              <p className="text-xs text-muted-themed mb-1">Vendor quoted:</p>
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-gold)' }}>
                ${workOrder.quoted_amount!.toFixed(2)}
              </p>
              {workOrder.quote_notes && (
                <p className="text-xs text-secondary-themed mt-1 italic">{workOrder.quote_notes}</p>
              )}
              <div className="flex gap-2 mt-3">
                <button
                  disabled={approving}
                  onClick={() => startApprove(async () => {
                    const r = await approveVendorQuote(workOrder.id)
                    if (r.error) setErr(r.error)
                  })}
                  className="btn-primary text-sm"
                >
                  {approving ? <><Loader2 className="w-4 h-4 animate-spin" /> Approving…</> : '✓ Approve & Assign'}
                </button>
                <button
                  onClick={() => startRequest(async () => {
                    const r = await updateWorkOrderStatus(workOrder.id, 'cancelled')
                  })}
                  className="btn-danger text-sm"
                >
                  Decline
                </button>
              </div>
            </div>
          ) : (
            <div className="p-3 rounded-lg" style={{ background: 'var(--accent-gold-dim)', border: '1px solid rgba(252,209,22,0.3)' }}>
              <p className="text-sm font-medium" style={{ color: 'var(--accent-gold)' }}>
                Waiting for vendor to submit quote
              </p>
              {quoteExpired && (
                <p className="text-xs mt-1" style={{ color: 'var(--accent-red)' }}>Quote link has expired.</p>
              )}
            </div>
          )}

          {quotePortalUrl && !hasQuote && (
            <div>
              <p className="text-xs text-muted-themed mb-1">Share this link with the vendor:</p>
              <a href={quotePortalUrl} target="_blank" rel="noopener noreferrer"
                 className="text-xs flex items-center gap-1 hover:underline break-all"
                 style={{ color: 'var(--accent-blue)' }}>
                {quotePortalUrl} <ExternalLink className="w-3 h-3 flex-shrink-0" />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Feature 2: Cost logging panel ────────────────────────────────────────────

function CostPanel({ workOrder }: { workOrder: WorkOrderDetailProps }) {
  const [editing, setEditing]     = useState(false)
  const [amount, setAmount]       = useState(String(workOrder.actual_cost ?? workOrder.estimated_cost ?? ''))
  const [invoice, setInvoice]     = useState(workOrder.invoice_reference ?? '')
  const [saving, startSave]       = useTransition()
  const [error, setError]         = useState<string | null>(null)

  function handleSave() {
    const parsed = parseFloat(amount)
    if (!parsed || parsed <= 0) { setError('Enter a valid amount'); return }
    setError(null)
    startSave(async () => {
      const r = await logActualCost(workOrder.id, { actual_cost: parsed, invoice_reference: invoice || undefined })
      if (r.error) setError(r.error)
      else setEditing(false)
    })
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="section-header mb-0">Cost & Invoice</h3>
        {!editing && workOrder.status !== 'completed' && (
          <button onClick={() => setEditing(true)} className="btn-ghost py-1 px-2 text-xs">
            <Receipt className="w-3.5 h-3.5 mr-1" /> Log Cost
          </button>
        )}
      </div>

      <div className="space-y-2 text-sm">
        {workOrder.estimated_cost != null && (
          <div className="flex items-center gap-2">
            <DollarSign className="w-3.5 h-3.5 text-muted-themed flex-shrink-0" />
            <span className="text-muted-themed text-xs w-24 flex-shrink-0">Estimated</span>
            <span className="font-medium text-primary-themed">${workOrder.estimated_cost.toFixed(2)}</span>
          </div>
        )}
        {workOrder.actual_cost != null && (
          <div className="flex items-center gap-2">
            <DollarSign className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
            <span className="text-muted-themed text-xs w-24 flex-shrink-0">Actual</span>
            <span className="font-bold" style={{ color: 'var(--accent-green)' }}>${workOrder.actual_cost.toFixed(2)}</span>
          </div>
        )}
        {workOrder.invoice_reference && (
          <div className="flex items-center gap-2">
            <Receipt className="w-3.5 h-3.5 text-muted-themed flex-shrink-0" />
            <span className="text-muted-themed text-xs w-24 flex-shrink-0">Invoice #</span>
            <span className="font-medium text-primary-themed">{workOrder.invoice_reference}</span>
          </div>
        )}
        {workOrder.estimated_cost == null && workOrder.actual_cost == null && (
          <p className="text-xs text-muted-themed">No cost logged yet.</p>
        )}
      </div>

      {editing && (
        <div className="pt-3 border-t border-themed space-y-2">
          {error && (
            <p className="text-xs" style={{ color: 'var(--accent-red)' }}>{error}</p>
          )}
          <div>
            <label className="label">Actual Cost</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-themed text-sm">$</span>
              <input type="number" min="0" step="0.01" value={amount}
                     onChange={(e) => setAmount(e.target.value)}
                     className="input pl-7 text-sm" placeholder="0.00" />
            </div>
          </div>
          <div>
            <label className="label">Invoice # (optional)</label>
            <input type="text" value={invoice} onChange={(e) => setInvoice(e.target.value)}
                   className="input text-sm" placeholder="INV-001" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving} className="btn-primary text-sm">
              {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save Cost'}
            </button>
            <button onClick={() => { setEditing(false); setError(null) }} className="btn-ghost text-sm">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Feature 1: Photo gallery ──────────────────────────────────────────────────

function PhotoGallery({ workOrderId, photos }: { workOrderId: string; photos: WorkOrderPhoto[] }) {
  const supabase    = createClient()
  const fileRef     = useRef<HTMLInputElement>(null)
  const [uploading, setUploading]   = useState(false)
  const [deleting, setDeleting]     = useState<string | null>(null)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [uploadErr, setUploadErr]   = useState<string | null>(null)

  const loadUrl = async (path: string) => {
    if (signedUrls[path]) return
    const { data } = await supabase.storage
      .from('work-order-photos')
      .createSignedUrl(path, 3600)
    if (data?.signedUrl) {
      setSignedUrls((prev) => ({ ...prev, [path]: data.signedUrl }))
    }
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadErr(null)
    try {
      const ext  = file.name.split('.').pop() ?? 'jpg'
      const path = `work-orders/${workOrderId}/pm-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from('work-order-photos')
        .upload(path, file, { contentType: file.type })
      if (uploadError) throw new Error(uploadError.message)
      const r = await recordWorkOrderPhoto(workOrderId, path)
      if (r.error) throw new Error(r.error)
    } catch (err: unknown) {
      setUploadErr((err as Error).message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleDelete = async (photoId: string) => {
    setDeleting(photoId)
    await deleteWorkOrderPhoto(photoId)
    setDeleting(null)
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="section-header mb-0">
          Photos
          {photos.length > 0 && <span className="ml-2 badge badge-slate">{photos.length}</span>}
        </h3>
        <button onClick={() => fileRef.current?.click()} disabled={uploading}
                className="btn-secondary text-xs py-1.5 px-2.5">
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
          {uploading ? 'Uploading…' : 'Add Photo'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
      </div>

      {uploadErr && (
        <p className="text-xs mb-3" style={{ color: 'var(--accent-red)' }}>{uploadErr}</p>
      )}

      {photos.length === 0 ? (
        <div className="flex flex-col items-center py-6 gap-2" style={{ color: 'var(--text-muted)' }}>
          <ImageIcon className="w-8 h-8" />
          <p className="text-xs">No photos yet. Add before/after photos to document this work order.</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((photo) => {
            if (!signedUrls[photo.storage_path]) loadUrl(photo.storage_path)
            const url = signedUrls[photo.storage_path]
            return (
              <div key={photo.id} className="relative group rounded-lg overflow-hidden aspect-square"
                   style={{ background: 'var(--bg-raised)' }}>
                {url ? (
                  <img src={url} alt="Work order photo"
                       className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-muted)' }} />
                  </div>
                )}
                <button
                  onClick={() => handleDelete(photo.id)}
                  disabled={deleting === photo.id}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center
                             opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ background: 'rgba(240,84,84,0.9)', color: 'white' }}
                >
                  {deleting === photo.id
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <X className="w-3 h-3" />}
                </button>
                <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                     style={{ background: 'rgba(0,0,0,0.6)', color: 'white' }}>
                  {photo.uploaded_by === 'vendor_portal' ? 'Vendor' : 'PM'} · {formatDate(photo.created_at, 'MMM d')}
                </div>
              </div>
            )
          })}
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
      <h3 className="section-header mb-3">Activity</h3>
      <div className="space-y-2">
        {updates.map((u) => (
          <div key={u.id} className="flex items-start gap-3 text-sm">
            <div className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                 style={{ background: 'var(--accent-gold)' }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {u.status_from && (
                  <>
                    <span className={statusBadgeClass(u.status_from)}>
                      {WO_STATUS_LABELS[u.status_from]}
                    </span>
                    <ArrowRight className="w-3 h-3 text-muted-themed" />
                  </>
                )}
                {u.status_to && (
                  <span className={statusBadgeClass(u.status_to)}>
                    {WO_STATUS_LABELS[u.status_to]}
                  </span>
                )}
                {u.updated_via_vendor_portal && (
                  <span className="badge badge-blue text-xs">via vendor portal</span>
                )}
                <span className="text-xs text-muted-themed ml-auto">{formatDateTime(u.created_at)}</span>
              </div>
              {u.notes && (
                <p className="text-xs text-secondary-themed mt-0.5 italic">{u.notes}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Delete control ────────────────────────────────────────────────────────────

function DeleteControl({ workOrderId, status }: { workOrderId: string; status: WoStatus }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, startDelete]     = useTransition()

  if (status === 'cancelled') return null

  return (
    <div>
      {!confirming ? (
        <button onClick={() => setConfirming(true)}
                className="btn-ghost text-xs py-1.5"
                style={{ color: 'var(--accent-red)' }}>
          <Trash2 className="w-3 h-3" /> Cancel Work Order
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-themed">Cancel this work order?</p>
          <button onClick={() => startDelete(() => deleteWorkOrder(workOrderId))}
                  disabled={deleting}
                  className="btn-danger text-xs py-1.5">
            {deleting ? 'Cancelling…' : 'Yes, cancel'}
          </button>
          <button onClick={() => setConfirming(false)} className="btn-ghost text-xs py-1.5">Never mind</button>
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function WorkOrderDetail({
  workOrder,
  updates,
  photos,
  vendors = [],
}: {
  workOrder: WorkOrderDetailProps
  updates: WorkOrderUpdate[]
  photos: WorkOrderPhoto[]
  vendors?: { id: string; name: string; specialty: string }[]
}) {
  const property = Array.isArray(workOrder.properties) ? workOrder.properties[0] : workOrder.properties
  const vendor   = Array.isArray(workOrder.vendors)   ? workOrder.vendors[0]   : workOrder.vendors

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
      estimated_cost: fd.get('estimated_cost') ? parseFloat(fd.get('estimated_cost') as string) : null,
      portal_enabled: fd.get('portal_enabled') === 'true',
    })
    setSaving(false)
    if (result.error) { setEditError(result.error); return }
    setEditing(false)
  }

  const handleAddNote = async () => {
    if (!noteText.trim()) return
    setAddingNote(true)
    await addWorkOrderNote(workOrder.id, noteText.trim())
    setNoteText('')
    setAddingNote(false)
  }

  return (
    <div>
      {/* Breadcrumb + header */}
      <div className="flex items-start gap-2 text-sm text-muted-themed mb-1">
        <Link href="/maintenance" className="hover:text-secondary-themed">Maintenance</Link>
        <span>/</span>
        <span className="text-secondary-themed truncate">{workOrder.title}</span>
      </div>

      <div className="flex items-start justify-between mb-6 gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="page-title">{workOrder.title}</h1>
          <span className={priorityBadgeClass(workOrder.priority)}>{PRIORITY_LABELS[workOrder.priority]}</span>
          <span className={statusBadgeClass(workOrder.status)}>{WO_STATUS_LABELS[workOrder.status]}</span>
          {workOrder.source && (
            <span className="text-xs text-muted-themed">
              {SOURCE_LABELS[workOrder.source] ?? workOrder.source}
            </span>
          )}
        </div>
        <button onClick={() => setEditing((v) => !v)} className="btn-ghost text-xs py-1.5 flex-shrink-0">
          <Pencil className="w-3.5 h-3.5" />
          {editing ? 'Cancel Edit' : 'Edit'}
        </button>
      </div>

      {/* Edit form */}
      {editing && (
        <div className="card mb-6">
          {editError && (
            <div className="text-sm rounded-lg px-3 py-2 mb-4"
                 style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}>
              {editError}
            </div>
          )}
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="label">Title</label>
                <input name="title" type="text" required defaultValue={workOrder.title} className="input" />
              </div>
              <div className="col-span-2">
                <label className="label">Description</label>
                <textarea name="description" rows={3} className="input resize-none"
                          defaultValue={workOrder.description ?? ''} />
              </div>
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
                <input name="scheduled_date" type="date" className="input"
                       defaultValue={workOrder.scheduled_date ?? ''} />
              </div>
              <div>
                <label className="label">Vendor</label>
                <select name="vendor_id" className="input" defaultValue={workOrder.vendor_id ?? ''}>
                  <option value="">No vendor</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Estimated Cost</label>
                <input name="estimated_cost" type="number" step="0.01" className="input"
                       defaultValue={workOrder.estimated_cost ?? ''} />
              </div>
              <div>
                <label className="label">Vendor Portal</label>
                <select name="portal_enabled" className="input"
                        defaultValue={workOrder.portal_enabled ? 'true' : 'false'}>
                  <option value="false">Portal disabled</option>
                  <option value="true">Portal enabled</option>
                </select>
              </div>
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

          {workOrder.description && (
            <div className="card">
              <h3 className="section-header">Description</h3>
              <p className="text-sm text-secondary-themed whitespace-pre-wrap">{workOrder.description}</p>
            </div>
          )}

          {/* Feature 5: Quote panel */}
          <QuotePanel workOrder={workOrder} />

          {workOrder.completion_notes && (
            <div className="card" style={{ background: 'var(--accent-green-dim)', border: '1px solid rgba(47,217,140,0.25)' }}>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2"
                  style={{ color: 'var(--accent-green)' }}>
                <CheckCircle2 className="w-4 h-4" /> Completion Notes
              </h3>
              <p className="text-sm text-secondary-themed whitespace-pre-wrap">{workOrder.completion_notes}</p>
              {workOrder.completed_date && (
                <p className="text-xs text-muted-themed mt-2">Completed: {formatDate(workOrder.completed_date)}</p>
              )}
            </div>
          )}

          {/* Feature 1: Photos */}
          <PhotoGallery workOrderId={workOrder.id} photos={photos} />

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
              <button onClick={handleAddNote} disabled={addingNote || !noteText.trim()}
                      className="btn-secondary self-end px-3 py-2 text-sm">
                {addingNote ? '…' : 'Add'}
              </button>
            </div>
          </div>

          {/* Status Controls */}
          {workOrder.status !== 'completed' && workOrder.status !== 'cancelled' && (
            <div className="card">
              <StatusControls workOrderId={workOrder.id} currentStatus={workOrder.status} />
            </div>
          )}

          {/* Activity */}
          {updates.length > 0 && (
            <div className="card">
              <StatusTimeline updates={updates} />
            </div>
          )}

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
                <p className="font-medium text-primary-themed">{property.name}</p>
                {(property.city || property.state) && (
                  <p className="text-xs text-muted-themed mt-0.5">
                    {[property.city, property.state].filter(Boolean).join(', ')}
                  </p>
                )}
                <Link href={`/properties/${property.id}`}
                      className="text-xs flex items-center gap-1 mt-2 hover:underline"
                      style={{ color: 'var(--accent-blue)' }}>
                  View Property <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            ) : (
              <p className="text-sm text-muted-themed">No property linked</p>
            )}
          </div>

          {/* Vendor */}
          {vendor && (
            <div className="card">
              <h3 className="section-header">Vendor</h3>
              <p className="font-medium text-primary-themed">{vendor.name}</p>
              <p className="text-xs text-muted-themed capitalize mt-0.5">{vendor.specialty.replace('_', ' ')}</p>
              {vendor.email && (
                <a href={`mailto:${vendor.email}`} className="text-xs mt-1 block hover:underline"
                   style={{ color: 'var(--accent-blue)' }}>
                  {vendor.email}
                </a>
              )}
              {vendor.phone && (
                <a href={`tel:${vendor.phone}`} className="text-xs text-muted-themed hover:text-secondary-themed mt-0.5 block">
                  {vendor.phone}
                </a>
              )}
            </div>
          )}

          {/* Feature 2: Cost & Invoice */}
          <CostPanel workOrder={workOrder} />

          {/* Dates */}
          <div className="card space-y-2.5">
            <h3 className="section-header">Dates</h3>
            {workOrder.scheduled_date && (
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="w-3.5 h-3.5 text-muted-themed flex-shrink-0" />
                <span className="text-muted-themed text-xs w-20 flex-shrink-0">Scheduled</span>
                <span className="text-primary-themed font-medium">{formatDate(workOrder.scheduled_date)}</span>
              </div>
            )}
            {workOrder.completed_date && (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
                <span className="text-muted-themed text-xs w-20 flex-shrink-0">Completed</span>
                <span className="text-primary-themed font-medium">{formatDate(workOrder.completed_date)}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-3.5 h-3.5 text-muted-themed flex-shrink-0" />
              <span className="text-muted-themed text-xs w-20 flex-shrink-0">Updated</span>
              <span className="text-muted-themed text-xs">{formatDateTime(workOrder.updated_at)}</span>
            </div>
          </div>

          {/* Vendor Portal Link */}
          {workOrder.portal_enabled && workOrder.completion_token && (
            <div className="card" style={{ background: 'var(--accent-blue-dim)', border: '1px solid rgba(77,166,255,0.25)' }}>
              <h3 className="text-xs font-semibold uppercase tracking-wide mb-2"
                  style={{ color: 'var(--accent-blue)' }}>
                Vendor Portal
              </h3>
              <p className="text-xs text-muted-themed mb-2">
                Share this link with the vendor to let them mark the work order complete.
              </p>
              <a href={`/work-orders/${workOrder.completion_token}`}
                 target="_blank" rel="noopener noreferrer"
                 className="text-xs font-medium flex items-center gap-1 break-all hover:underline"
                 style={{ color: 'var(--accent-blue)' }}>
                View portal link <ExternalLink className="w-3 h-3 flex-shrink-0" />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
