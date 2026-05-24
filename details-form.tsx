'use client'

import { useState, useTransition, useActionState } from 'react'
import Link from 'next/link'
import {
  Plus, RefreshCw, CalendarCheck, Clock, User, ChevronDown,
  AlertTriangle, CheckCircle2, Flag, X, Filter
} from 'lucide-react'
import { cn, formatWindow, TURNOVER_STATUS_LABELS, PRIORITY_COLORS } from '@/lib/utils'
import { assignCrew, updateTurnoverStatus, createManualTurnover, triggerManualSync } from './actions'

// ── Types ────────────────────────────────────────────────────────────────────

interface CrewMember { id: string; name: string; phone: string | null; email: string | null; specialty: string }
interface Property   { id: string; name: string; city: string | null; state: string | null }

interface TurnoverAssignment {
  id: string
  crew_member_id: string
  crew_members: CrewMember | CrewMember[] | null
}

interface Turnover {
  id: string
  property_id: string
  checkout_datetime: string
  checkin_datetime: string
  window_minutes: number | null
  status: string
  priority: string
  notes: string | null
  completed_at: string | null
  checklist_template_id: string | null
  turnover_assignments: TurnoverAssignment | TurnoverAssignment[] | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isToday(d: Date): boolean {
  const now = new Date()
  return d.toDateString() === now.toDateString()
}

function isTomorrow(d: Date): boolean {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  return d.toDateString() === tomorrow.toDateString()
}

function isPast(d: Date): boolean {
  return d < new Date()
}

function groupTurnovers(turnovers: Turnover[]) {
  const groups: Record<string, Turnover[]> = {
    urgent:   [],
    today:    [],
    tomorrow: [],
    week:     [],
    upcoming: [],
    recent:   [],
  }

  for (const t of turnovers) {
    const checkout = new Date(t.checkout_datetime)

    if (t.status === 'completed') {
      groups.recent.push(t)
      continue
    }

    if (isPast(checkout) && t.status !== 'in_progress') {
      groups.urgent.push(t)
    } else if (
      (t.priority === 'urgent' || t.priority === 'high') &&
      !isToday(checkout)
    ) {
      // High priority upcoming — still put in their date bucket but flag them
      if (isToday(checkout)) groups.today.push(t)
      else if (isTomorrow(checkout)) groups.tomorrow.push(t)
      else groups.week.push(t)
    } else if (isToday(checkout)) {
      groups.today.push(t)
    } else if (isTomorrow(checkout)) {
      groups.tomorrow.push(t)
    } else {
      const daysOut = Math.ceil((checkout.getTime() - Date.now()) / 86_400_000)
      if (daysOut <= 7) groups.week.push(t)
      else groups.upcoming.push(t)
    }
  }

  return groups
}

function getAssignedCrew(t: Turnover): CrewMember | null {
  const assignments = Array.isArray(t.turnover_assignments)
    ? t.turnover_assignments
    : t.turnover_assignments ? [t.turnover_assignments] : []

  if (!assignments.length) return null
  const first = assignments[0]
  return Array.isArray(first.crew_members) ? first.crew_members[0] : first.crew_members
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending_assignment: 'badge badge-amber',
    assigned:           'badge badge-blue',
    in_progress:        'badge bg-purple-50 text-purple-700',
    completed:          'badge badge-green',
    flagged:            'badge badge-red',
  }
  return map[status] ?? 'badge badge-slate'
}

// ── Crew Assign Dropdown ─────────────────────────────────────────────────────

function CrewAssignDropdown({
  turnover,
  crewMembers,
  assignedCrew,
}: {
  turnover: Turnover
  crewMembers: CrewMember[]
  assignedCrew: CrewMember | null
}) {
  const [open, setOpen] = useState(false)
  const [assigning, startAssign] = useTransition()

  const handleAssign = (crewId: string) => {
    setOpen(false)
    startAssign(async () => {
      await assignCrew([turnover.id], crewId)
    })
  }

  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        disabled={assigning || turnover.status === 'completed' || turnover.status === 'cancelled'}
        className={cn(
          'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-all',
          assignedCrew
            ? 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100'
            : 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100',
          'disabled:opacity-50 disabled:cursor-default'
        )}
      >
        <User className="w-3 h-3" />
        {assigning ? 'Assigning…' : (assignedCrew?.name ?? 'Assign Crew')}
        {!assigning && <ChevronDown className="w-3 h-3" />}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-20 bg-white border border-accent-200 rounded-xl shadow-card-lg py-1 min-w-[160px]">
            {crewMembers.length === 0 ? (
              <p className="px-3 py-2 text-xs text-accent-400">No crew members yet</p>
            ) : (
              crewMembers.map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleAssign(c.id)}
                  className={cn(
                    'w-full text-left px-3 py-2 text-sm hover:bg-accent-50 transition-colors flex items-center gap-2',
                    assignedCrew?.id === c.id && 'text-brand-700 font-medium'
                  )}
                >
                  <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
                    {c.name[0]?.toUpperCase()}
                  </span>
                  {c.name}
                  {assignedCrew?.id === c.id && <CheckCircle2 className="w-3 h-3 ml-auto text-brand-600" />}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Turnover Card ────────────────────────────────────────────────────────────

function TurnoverCard({
  turnover,
  property,
  crewMembers,
}: {
  turnover: Turnover
  property: Property | undefined
  crewMembers: CrewMember[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [updating, startUpdate] = useTransition()
  const [flagNotes, setFlagNotes] = useState('')
  const [showFlagInput, setShowFlagInput] = useState(false)

  const checkout     = new Date(turnover.checkout_datetime)
  const checkin      = new Date(turnover.checkin_datetime)
  const assignedCrew = getAssignedCrew(turnover)
  const isOverdue    = isPast(checkout) && turnover.status !== 'completed' && turnover.status !== 'in_progress'
  const windowMins   = turnover.window_minutes ?? 0
  const windowColor  =
    windowMins < 120 ? 'text-red-600'   :
    windowMins < 240 ? 'text-amber-600' :
    windowMins < 480 ? 'text-blue-600'  : 'text-green-600'

  const handleStatus = (status: 'in_progress' | 'completed' | 'flagged' | 'cancelled') => {
    if (status === 'flagged' && !flagNotes) {
      setShowFlagInput(true)
      return
    }
    startUpdate(async () => {
      await updateTurnoverStatus(turnover.id, status, flagNotes || undefined)
      setShowFlagInput(false)
      setExpanded(false)
    })
  }

  return (
    <div
      className={cn(
        'bg-white rounded-xl border transition-shadow',
        isOverdue          ? 'border-red-200 shadow-[0_0_0_1px_#fca5a5]' :
        turnover.priority === 'urgent' ? 'border-red-200' :
        turnover.priority === 'high'   ? 'border-amber-200' :
        'border-accent-200',
        'hover:shadow-card-md'
      )}
    >
      {/* Card header — always visible */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        {/* Priority / overdue indicator */}
        <div className={cn(
          'w-1 self-stretch rounded-full flex-shrink-0',
          isOverdue              ? 'bg-red-500' :
          turnover.priority === 'urgent' ? 'bg-red-400' :
          turnover.priority === 'high'   ? 'bg-amber-400' :
          turnover.priority === 'medium' ? 'bg-blue-300' : 'bg-accent-200'
        )} />

        <div className="flex-1 min-w-0">
          {/* Property + status */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-accent-900 text-sm">
              {property?.name ?? 'Unknown Property'}
            </span>
            {property?.city && (
              <span className="text-xs text-accent-400">{property.city}</span>
            )}
            <span className={statusBadge(turnover.status)}>
              {TURNOVER_STATUS_LABELS[turnover.status as keyof typeof TURNOVER_STATUS_LABELS] ?? turnover.status}
            </span>
            {isOverdue && (
              <span className="badge badge-red flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" /> Overdue
              </span>
            )}
          </div>

          {/* Times + window */}
          <div className="flex items-center gap-3 mt-1.5 text-xs text-accent-500">
            <span>
              <span className="font-medium text-accent-700">Out:</span>{' '}
              {checkout.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}{' '}
              {checkout.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </span>
            <span className="text-accent-300">→</span>
            <span>
              <span className="font-medium text-accent-700">In:</span>{' '}
              {checkin.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              {checkin.toDateString() !== checkout.toDateString() && (
                <span className="text-accent-400 ml-1">
                  ({checkin.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
                </span>
              )}
            </span>
            <span className={cn('font-semibold flex items-center gap-0.5', windowColor)}>
              <Clock className="w-3 h-3" />
              {formatWindow(windowMins)}
            </span>
          </div>
        </div>

        {/* Crew + expand */}
        <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <CrewAssignDropdown
            turnover={turnover}
            crewMembers={crewMembers}
            assignedCrew={assignedCrew}
          />
          <ChevronDown className={cn('w-4 h-4 text-accent-400 transition-transform', expanded && 'rotate-180')} />
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-accent-100 p-4 space-y-4">
          {turnover.notes && (
            <p className="text-sm text-accent-600 bg-accent-50 rounded-lg px-3 py-2">
              {turnover.notes}
            </p>
          )}

          {/* Flag notes input */}
          {showFlagInput && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-accent-600">What needs attention?</label>
              <textarea
                value={flagNotes}
                onChange={(e) => setFlagNotes(e.target.value)}
                rows={2}
                className="input text-sm resize-none"
                placeholder="Describe the issue…"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => handleStatus('flagged')}
                  className="btn-danger text-sm py-1.5"
                  disabled={!flagNotes.trim() || updating}
                >
                  Flag Turnover
                </button>
                <button onClick={() => setShowFlagInput(false)} className="btn-ghost text-sm py-1.5">Cancel</button>
              </div>
            </div>
          )}

          {/* Action buttons */}
          {!showFlagInput && turnover.status !== 'completed' && turnover.status !== 'cancelled' && (
            <div className="flex items-center gap-2 flex-wrap">
              {turnover.status === 'assigned' && (
                <button
                  onClick={() => handleStatus('in_progress')}
                  disabled={updating}
                  className="btn-secondary text-xs py-1.5"
                >
                  Mark In Progress
                </button>
              )}
              {(turnover.status === 'assigned' || turnover.status === 'in_progress') && (
                <button
                  onClick={() => handleStatus('completed')}
                  disabled={updating}
                  className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors font-medium flex items-center gap-1.5 disabled:opacity-50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {updating ? 'Saving…' : 'Mark Complete'}
                </button>
              )}
              <button
                onClick={() => setShowFlagInput(true)}
                disabled={updating}
                className="btn-ghost text-xs py-1.5 text-amber-600 hover:bg-amber-50"
              >
                <Flag className="w-3.5 h-3.5" /> Flag Issue
              </button>
              <Link
                href={`/turnovers/${turnover.id}`}
                className="btn-ghost text-xs py-1.5 ml-auto"
              >
                View Full Details →
              </Link>
            </div>
          )}

          {turnover.status === 'completed' && turnover.completed_at && (
            <p className="text-xs text-green-600 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Completed {new Date(turnover.completed_at).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Group Section ────────────────────────────────────────────────────────────

function BoardSection({
  label,
  turnovers,
  propertyMap,
  crewMembers,
  defaultOpen = true,
  variant = 'default',
}: {
  label: string
  turnovers: Turnover[]
  propertyMap: Record<string, Property>
  crewMembers: CrewMember[]
  defaultOpen?: boolean
  variant?: 'default' | 'urgent' | 'muted'
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (!turnovers.length) return null

  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 mb-3 group w-full text-left"
      >
        <span className={cn(
          'text-sm font-semibold',
          variant === 'urgent' ? 'text-red-600' :
          variant === 'muted'  ? 'text-accent-400' : 'text-accent-700'
        )}>
          {label}
        </span>
        <span className={cn(
          'badge text-xs',
          variant === 'urgent' ? 'bg-red-50 text-red-600' : 'badge-slate'
        )}>
          {turnovers.length}
        </span>
        <ChevronDown className={cn('w-3.5 h-3.5 text-accent-400 ml-auto transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-3">
          {turnovers.map((t) => (
            <TurnoverCard
              key={t.id}
              turnover={t}
              property={propertyMap[t.property_id]}
              crewMembers={crewMembers}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Add Turnover Modal ───────────────────────────────────────────────────────

function AddTurnoverModal({
  properties,
  onClose,
}: {
  properties: Property[]
  onClose: () => void
}) {
  const [state, action, pending] = useActionState(createManualTurnover, null)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-card-lg w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-accent-900">Add Turnover</h3>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {state?.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
            {state.error}
          </div>
        )}

        <form action={async (fd) => { await action(fd); if (!state?.error) onClose() }} className="space-y-4">
          <div>
            <label className="label">Property</label>
            <select name="property_id" required className="input">
              <option value="">Select property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Checkout Date</label>
              <input name="checkout_date" type="date" required className="input" />
            </div>
            <div>
              <label className="label">Checkout Time</label>
              <input name="checkout_time" type="time" defaultValue="11:00" className="input" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Next Check-in Date</label>
              <input name="checkin_date" type="date" required className="input" />
            </div>
            <div>
              <label className="label">Check-in Time</label>
              <input name="checkin_time" type="time" defaultValue="15:00" className="input" />
            </div>
          </div>
          <div>
            <label className="label">Notes (optional)</label>
            <textarea name="notes" rows={2} className="input resize-none" placeholder="Any special instructions…" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={pending} className="btn-primary flex-1">
              {pending ? 'Creating…' : 'Create Turnover'}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main Board ───────────────────────────────────────────────────────────────

export function TurnoverBoard({
  turnovers,
  propertyMap,
  crewMembers,
  properties,
  orgId,
}: {
  turnovers: Turnover[]
  propertyMap: Record<string, Property>
  crewMembers: CrewMember[]
  properties: Property[]
  orgId: string
}) {
  const [showAdd, setShowAdd]     = useState(false)
  const [syncing, startSync]      = useTransition()
  const [filterProp, setFilterProp] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('active')

  // Filter
  const filtered = turnovers.filter((t) => {
    if (filterProp !== 'all' && t.property_id !== filterProp) return false
    if (filterStatus === 'active'    && (t.status === 'completed' || t.status === 'cancelled')) return false
    if (filterStatus === 'completed' && t.status !== 'completed') return false
    return true
  })

  const groups = groupTurnovers(filtered)

  const totalActive = turnovers.filter((t) =>
    t.status !== 'completed' && t.status !== 'cancelled'
  ).length

  const needsCrew = turnovers.filter((t) =>
    t.status === 'pending_assignment'
  ).length

  return (
    <>
      {/* Page header */}
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Turnovers</h1>
          <div className="flex items-center gap-3 mt-1">
            <p className="page-subtitle">{totalActive} active</p>
            {needsCrew > 0 && (
              <span className="badge badge-amber">
                <AlertTriangle className="w-3 h-3" />
                {needsCrew} need crew
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => startSync(() => triggerManualSync(orgId))}
            disabled={syncing}
            className="btn-secondary"
            title="Sync calendars now"
          >
            <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <button onClick={() => setShowAdd(true)} className="btn-primary">
            <Plus className="w-4 h-4" />
            Add Turnover
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-1.5 bg-white border border-accent-200 rounded-lg px-1 py-1">
          {(['active', 'completed', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize',
                filterStatus === s
                  ? 'bg-brand-800 text-white'
                  : 'text-accent-500 hover:text-accent-700'
              )}
            >
              {s}
            </button>
          ))}
        </div>

        {properties.length > 1 && (
          <select
            value={filterProp}
            onChange={(e) => setFilterProp(e.target.value)}
            className="input text-sm py-1.5 w-auto"
          >
            <option value="all">All Properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Board */}
      {filtered.length === 0 ? (
        <div className="card text-center py-16 max-w-md mx-auto mt-4">
          <CalendarCheck className="w-10 h-10 text-accent-300 mx-auto mb-3" />
          <h3 className="font-semibold text-accent-700 mb-1">No turnovers found</h3>
          <p className="text-sm text-accent-400">
            {turnovers.length === 0
              ? 'Add a property and connect your calendar to start seeing turnovers here.'
              : 'No turnovers match the current filter.'
            }
          </p>
        </div>
      ) : (
        <div>
          <BoardSection
            label="🚨 Needs Attention"
            turnovers={groups.urgent}
            propertyMap={propertyMap}
            crewMembers={crewMembers}
            variant="urgent"
          />
          <BoardSection
            label="Today"
            turnovers={groups.today}
            propertyMap={propertyMap}
            crewMembers={crewMembers}
          />
          <BoardSection
            label="Tomorrow"
            turnovers={groups.tomorrow}
            propertyMap={propertyMap}
            crewMembers={crewMembers}
          />
          <BoardSection
            label="This Week"
            turnovers={groups.week}
            propertyMap={propertyMap}
            crewMembers={crewMembers}
          />
          <BoardSection
            label="Upcoming"
            turnovers={groups.upcoming}
            propertyMap={propertyMap}
            crewMembers={crewMembers}
            defaultOpen={false}
          />
          {filterStatus !== 'active' && (
            <BoardSection
              label="Recently Completed"
              turnovers={groups.recent}
              propertyMap={propertyMap}
              crewMembers={crewMembers}
              defaultOpen={false}
              variant="muted"
            />
          )}
        </div>
      )}

      {/* Add turnover modal */}
      {showAdd && (
        <AddTurnoverModal
          properties={properties}
          onClose={() => setShowAdd(false)}
        />
      )}
    </>
  )
}
