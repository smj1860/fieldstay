'use client'

import { useState, useTransition, useActionState, useMemo } from 'react'
import Link from 'next/link'
import {
  Plus, X, Search, ChevronDown, ChevronUp, Trash2,
  Mail, Phone, MessageSquare, Users, Briefcase,
  FileText, Cpu,
} from 'lucide-react'
import { cn, formatDate, formatDateTime } from '@/lib/utils'
import { createCommunicationLog, deleteCommunicationLog } from './actions'
import type { CommChannel, CommRecipientType } from '@/types/database'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LogEntry {
  id:              string
  recipient_type:  CommRecipientType
  channel:         CommChannel
  subject:         string | null
  body:            string | null
  source:          'manual' | 'system'
  communicated_at: string
  vendor_id:       string | null
  crew_member_id:  string | null
  property_id:     string | null
  work_order_id:   string | null
  vendors:         { id: string; name: string; specialty: string } | null
  crew_members:    { id: string; name: string; specialty: string } | null
  properties:      { id: string; name: string } | null
  work_orders:     { id: string; title: string } | null
}

interface PersonOption     { id: string; name: string; specialty?: string }
interface PropertyOption   { id: string; name: string }
interface WorkOrderOption  { id: string; title: string }

function getEntityLink(entry: LogEntry): { href: string; label: string } | null {
  if (entry.work_order_id) return { href: `/maintenance/${entry.work_order_id}`, label: 'View work order →' }
  if (entry.property_id)   return { href: `/properties/${entry.property_id}`,    label: 'View property →' }
  return null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<CommChannel, string> = {
  email:     'Email',
  sms:       'SMS',
  phone:     'Phone Call',
  in_person: 'In Person',
  note:      'Note',
}

const CHANNEL_BADGE: Record<CommChannel, string> = {
  email:     'badge-blue',
  sms:       'badge-green',
  phone:     'badge-amber',
  in_person: 'badge-gold',
  note:      'badge-slate',
}

const CHANNEL_ICON: Record<CommChannel, React.ReactNode> = {
  email:     <Mail          className="w-3 h-3" />,
  sms:       <MessageSquare className="w-3 h-3" />,
  phone:     <Phone         className="w-3 h-3" />,
  in_person: <Users         className="w-3 h-3" />,
  note:      <FileText      className="w-3 h-3" />,
}

// ── Log entry row ─────────────────────────────────────────────────────────────

function LogRow({ entry }: Readonly<{ entry: LogEntry }>) {
  const [expanded, setExpanded]     = useState(false)
  const [deleting, startDelete]     = useTransition()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const recipient     = entry.recipient_type === 'vendor' ? entry.vendors : entry.crew_members
  const recipientName = recipient?.name ?? '—'

  return (
    <div
      className="rounded-xl border transition-colors"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
    >
      {/* Main row */}
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Recipient type icon */}
        <div
          className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-0.5"
          style={{
            background: entry.recipient_type === 'vendor'
              ? 'var(--accent-blue-dim)'
              : 'var(--accent-green-dim)',
          }}
        >
          {entry.recipient_type === 'vendor'
            ? <Briefcase className="w-3.5 h-3.5" style={{ color: 'var(--accent-blue)'  }} />
            : <Users     className="w-3.5 h-3.5" style={{ color: 'var(--accent-green)' }} />}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {recipientName}
            </span>
            <span className={cn('badge flex items-center gap-1', CHANNEL_BADGE[entry.channel])}>
              {CHANNEL_ICON[entry.channel]}
              {CHANNEL_LABELS[entry.channel]}
            </span>
            {entry.source === 'system' && (
              <span className="badge badge-slate flex items-center gap-1 text-xs">
                <Cpu className="w-2.5 h-2.5" /> System
              </span>
            )}
          </div>

          {entry.subject && (
            <p className="text-sm mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
              {entry.subject}
            </p>
          )}

          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {entry.properties && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {entry.properties.name}
              </span>
            )}
            {entry.work_orders && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                WO: {entry.work_orders.title}
              </span>
            )}
          </div>
        </div>

        {/* Date + chevron */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {formatDate(entry.communicated_at)}
          </span>
          {expanded
            ? <ChevronUp   className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
            : <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />}
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t" style={{ borderColor: 'var(--border)' }}>
          <div className="mt-3 space-y-3">
            {entry.body ? (
              <div
                className="text-sm rounded-lg p-3 whitespace-pre-wrap"
                style={{ background: 'var(--bg-canvas)', color: 'var(--text-secondary)' }}
              >
                {entry.body}
              </div>
            ) : (
              <p className="text-xs italic" style={{ color: 'var(--text-muted)' }}>
                No message body recorded.
              </p>
            )}

            {(() => {
              const link = getEntityLink(entry)
              return link ? (
                <Link
                  href={link.href}
                  className="text-xs font-medium inline-block"
                  style={{ color: 'var(--accent-gold)' }}
                >
                  {link.label}
                </Link>
              ) : null
            })()}

            <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
              <span>Logged {formatDateTime(entry.communicated_at)}</span>

              {entry.source === 'manual' && (
                !confirmDelete ? (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="flex items-center gap-1 hover:opacity-80 transition-opacity"
                    style={{ color: 'var(--accent-red)' }}
                  >
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span style={{ color: 'var(--text-secondary)' }}>Delete this entry?</span>
                    <button
                      onClick={() => startDelete(async () => {
                        await deleteCommunicationLog(entry.id)
                      })}
                      disabled={deleting}
                      className="font-medium hover:opacity-80"
                      style={{ color: 'var(--accent-red)' }}
                    >
                      {deleting ? 'Deleting…' : 'Yes'}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="hover:opacity-80"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Cancel
                    </button>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Add entry modal ───────────────────────────────────────────────────────────

function AddEntryModal({
  vendors,
  crew,
  properties,
  workOrders,
  onClose,
}: Readonly<{
  vendors:    PersonOption[]
  crew:       PersonOption[]
  properties: PropertyOption[]
  workOrders: WorkOrderOption[]
  onClose:    () => void
}>) {
  const [state, action, pending]         = useActionState(createCommunicationLog, null)
  const [recipientType, setRecipientType] = useState<CommRecipientType>('vendor')

  if (state?.success) { onClose(); return null }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 overflow-y-auto">
      <div
        className="rounded-2xl w-full max-w-lg p-6 my-4"
        style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg)' }}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            Log Communication
          </h3>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {vendors.length === 0 && crew.length === 0 && (
          <div className="mb-4 px-3 py-2 rounded-lg text-sm"
               style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)' }}>
            You need at least one vendor or crew member to log a communication.
            Add crew in the Crew section or vendors in the Vendors section first.
          </div>
        )}

        {state?.error && (
          <div
            className="text-sm rounded-lg px-3 py-2 mb-4"
            style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}
          >
            {state.error}
          </div>
        )}

        <form action={action} className="space-y-4">
          <input type="hidden" name="recipient_type" value={recipientType} />

          {/* Vendor / Crew toggle */}
          <div>
            <label className="label">Recipient</label>
            <div className="flex gap-2 mb-2">
              {(['vendor', 'crew'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setRecipientType(t)}
                  className={cn(
                    'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors',
                    recipientType === t
                      ? 'border-themed'
                      : 'bg-canvas-themed border-themed text-secondary-themed hover:text-primary-themed'
                  )}
                  style={recipientType === t
                    ? { background: 'var(--bg-raised)', color: 'var(--text-primary)', borderColor: 'var(--border-strong)' }
                    : undefined}
                >
                  {t === 'vendor' ? 'Vendor' : 'Crew Member'}
                </button>
              ))}
            </div>

            {recipientType === 'vendor' ? (
              <select name="vendor_id" required className="input">
                <option value="">Select vendor…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            ) : (
              <select name="crew_member_id" required className="input">
                <option value="">Select crew member…</option>
                {crew.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Channel */}
          <div>
            <label className="label">Channel</label>
            <select name="channel" className="input" defaultValue="email">
              {(Object.keys(CHANNEL_LABELS) as CommChannel[]).map((ch) => (
                <option key={ch} value={ch}>{CHANNEL_LABELS[ch]}</option>
              ))}
            </select>
          </div>

          {/* Date */}
          <div>
            <label className="label">Date &amp; Time</label>
            <input
              name="communicated_at"
              type="datetime-local"
              className="input"
              defaultValue={new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
                .toISOString()
                .slice(0, 16)}
            />
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Defaults to now. Edit if logging a past conversation.
            </p>
          </div>

          {/* Subject */}
          <div>
            <label className="label">Subject</label>
            <input
              name="subject"
              type="text"
              className="input"
              placeholder="e.g. HVAC repair instructions, Written warning"
            />
          </div>

          {/* Body */}
          <div>
            <label className="label">Message / Notes</label>
            <textarea
              name="body"
              rows={4}
              className="input resize-none"
              placeholder="Full message, call summary, or notes on what was communicated…"
            />
          </div>

          {/* Context links */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Property (optional)</label>
              <select name="property_id" className="input">
                <option value="">—</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Work Order (optional)</label>
              <select name="work_order_id" className="input">
                <option value="">—</option>
                {workOrders.map((w) => (
                  <option key={w.id} value={w.id}>{w.title}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={pending} className="btn-primary flex-1">
              {pending ? 'Saving…' : 'Save Entry'}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main client component ─────────────────────────────────────────────────────

export function CommsLogClient({
  logs,
  vendors,
  crew,
  properties,
  workOrders,
  page,
  hasMore,
}: Readonly<{
  logs:       LogEntry[]
  vendors:    PersonOption[]
  crew:       PersonOption[]
  properties: PropertyOption[]
  workOrders: WorkOrderOption[]
  page:       number
  hasMore:    boolean
}>) {
  const [showAdd, setShowAdd]               = useState(false)
  const [search, setSearch]                 = useState('')
  const [filterType, setFilterType]         = useState<'all' | CommRecipientType>('all')
  const [filterChannel, setFilterChannel]   = useState<'all' | CommChannel>('all')
  const [filterProperty, setFilterProperty] = useState<string>('all')

  const filtered = useMemo(() => {
    return logs.filter((entry) => {
      if (filterType !== 'all' && entry.recipient_type !== filterType) return false
      if (filterChannel !== 'all' && entry.channel !== filterChannel) return false
      if (filterProperty !== 'all' && entry.property_id !== filterProperty) return false
      if (search.trim()) {
        const q    = search.toLowerCase()
        const name = entry.recipient_type === 'vendor'
          ? (entry.vendors?.name     ?? '')
          : (entry.crew_members?.name ?? '')
        if (
          !name.toLowerCase().includes(q) &&
          !(entry.subject?.toLowerCase().includes(q) ?? false) &&
          !(entry.body?.toLowerCase().includes(q) ?? false)
        ) return false
      }
      return true
    })
  }, [logs, filterType, filterChannel, filterProperty, search])

  const hasFilters = !!(search || filterType !== 'all' || filterChannel !== 'all' || filterProperty !== 'all')

  return (
    <div>
      {/* Header */}
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Comms Log</h1>
          <p className="page-subtitle">Record of all communications with crew and vendors</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary">
          <Plus className="w-4 h-4" />
          Log Communication
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5"
            style={{ color: 'var(--text-muted)' }}
          />
          <input
            type="text"
            placeholder="Search by name, subject…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-8 text-sm py-1.5"
          />
        </div>

        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as typeof filterType)}
          className="input text-sm py-1.5 w-auto"
        >
          <option value="all">All Recipients</option>
          <option value="vendor">Vendors Only</option>
          <option value="crew">Crew Only</option>
        </select>

        <select
          value={filterChannel}
          onChange={(e) => setFilterChannel(e.target.value as typeof filterChannel)}
          className="input text-sm py-1.5 w-auto"
        >
          <option value="all">All Channels</option>
          {(Object.keys(CHANNEL_LABELS) as CommChannel[]).map((ch) => (
            <option key={ch} value={ch}>{CHANNEL_LABELS[ch]}</option>
          ))}
        </select>

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

        {hasFilters && (
          <button
            onClick={() => {
              setSearch('')
              setFilterType('all')
              setFilterChannel('all')
              setFilterProperty('all')
            }}
            className="btn-ghost text-xs py-1.5"
            style={{ color: 'var(--text-muted)' }}
          >
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 mb-4 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span>
          {filtered.length} entr{filtered.length !== 1 ? 'ies' : 'y'}
          {hasFilters && ` (filtered from ${logs.length})`}
        </span>
        <span>
          {logs.filter((l) => l.recipient_type === 'vendor').length} vendor ·{' '}
          {logs.filter((l) => l.recipient_type === 'crew').length} crew
        </span>
      </div>

      {/* Entries */}
      {filtered.length === 0 ? (
        <div className="card text-center py-16 max-w-md mx-auto mt-4">
          <FileText className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <h3 className="font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
            {logs.length === 0 ? 'No communications logged yet' : 'No entries match your filters'}
          </h3>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
            {logs.length === 0
              ? 'Start building your paper trail by logging your first crew or vendor communication.'
              : 'Try adjusting your filters or search term.'}
          </p>
          {logs.length === 0 && (
            <button onClick={() => setShowAdd(true)} className="btn-primary mx-auto">
              <Plus className="w-4 h-4" />
              Log First Entry
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => (
            <LogRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {(page > 1 || hasMore) && (
        <div className="flex items-center justify-between mt-4 text-xs">
          {page > 1 ? (
            <Link href={`/comms-log?page=${page - 1}`} className="font-medium" style={{ color: 'var(--accent-gold)' }}>
              ← Previous
            </Link>
          ) : <span />}
          <span style={{ color: 'var(--text-muted)' }}>Page {page}</span>
          {hasMore ? (
            <Link href={`/comms-log?page=${page + 1}`} className="font-medium" style={{ color: 'var(--accent-gold)' }}>
              Next →
            </Link>
          ) : <span />}
        </div>
      )}

      {showAdd && (
        <AddEntryModal
          vendors={vendors}
          crew={crew}
          properties={properties}
          workOrders={workOrders}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  )
}
