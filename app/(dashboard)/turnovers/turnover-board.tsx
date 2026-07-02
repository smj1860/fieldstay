'use client'

import { useState, useTransition, useActionState, useRef, useEffect, useMemo, useContext, createContext } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Plus, RefreshCw, CalendarCheck, Clock, ChevronDown,
  AlertTriangle, CheckCircle2, Flag, X, UserPlus, LayoutList, GanttChartSquare, Camera,
} from 'lucide-react'
import { cn, formatWindow, TURNOVER_STATUS_LABELS, formatDuration } from '@/lib/utils'
import {
  assignCrew, assignCrewIndividually, addCrewToTurnover, removeCrewFromTurnover,
  updateTurnoverStatus, createManualTurnover, triggerManualSync,
  bulkUpdateTurnoverStatus,
  acceptSuggestion, dismissSuggestion,
  archiveTurnover, unarchiveTurnover,
} from './actions'
import { TurnoverGantt } from './turnover-gantt'
import { createClient } from '@/lib/supabase/client'
import { NudgeBanner } from '@/components/nudge-banner'
import type { AssignedCrewMember } from '@/types/database'

// ── Types ────────────────────────────────────────────────────────────────────

interface CrewMember { id: string; name: string; phone: string | null; email: string | null; specialty: string }
interface Property   { id: string; name: string; city: string | null; state: string | null }

interface BookingRow {
  id: string
  property_id: string
  checkin_date: string
  checkout_date: string
  guest_name: string | null
  status: string
}

interface CrewAvailabilityRow {
  crew_member_id: string
  available_date: string
  is_available:   boolean
}

// Lookup map keyed by `${crew_member_id}::${YYYY-MM-DD}` → is_available.
// Days with no entry mean "no preference" and carry no badge.
const CrewAvailabilityContext = createContext<Record<string, boolean>>({})

interface TurnoverAssignment {
  id: string
  crew_member_id: string
  crew_member: AssignedCrewMember | null
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
  started_at: string | null
  checklist_template_id: string | null
  is_same_day_turnover: boolean | null
  suggested_crew_ids: string[] | null
  suggestion_reasoning: string | null
  suggestion_status: 'pending' | 'accepted' | 'dismissed' | null
  is_archived: boolean
  turnover_assignments: TurnoverAssignment[]
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

function getAllAssignedCrew(t: Turnover): AssignedCrewMember[] {
  return t.turnover_assignments.flatMap(a => a.crew_member ? [a.crew_member] : [])
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

// ── Crew Assignment (chip-based) ─────────────────────────────────────────────

function CrewAssignment({
  turnover,
  crewMembers,
  assignedCrew,
  onWarning,
  open,
  onOpenChange,
}: Readonly<{
  turnover:     Turnover
  crewMembers:  CrewMember[]
  assignedCrew: AssignedCrewMember[]
  onWarning?:   (msg: string) => void
  open:         boolean
  onOpenChange: (open: boolean) => void
}>) {
  const [adding,   startAdd]    = useTransition()
  const [removing, startRemove] = useTransition()

  const availabilityMap = useContext(CrewAvailabilityContext)
  const turnoverDate    = turnover.checkout_datetime.split('T')[0]

  const isDisabled = turnover.status === 'completed' || turnover.status === 'cancelled'
  const available  = crewMembers.filter(c => !assignedCrew.find(a => a.id === c.id))

  const availabilityBadge = (crewId: string) => {
    const entry = availabilityMap[`${crewId}::${turnoverDate}`]
    if (entry === undefined) return null
    return (
      <span title={entry ? 'Marked available that day' : 'Marked unavailable that day'}>
        {entry ? '🟢' : '🔴'}
      </span>
    )
  }

  const handleAdd = (crewId: string) => {
    onOpenChange(false)
    startAdd(async () => {
      const result = await addCrewToTurnover([turnover.id], crewId)
      if (result?.warning) onWarning?.(result.warning)
    })
  }

  const handleRemove = (crewId: string) => {
    startRemove(async () => { await removeCrewFromTurnover(turnover.id, crewId) })
  }

  return (
    <div
      className="flex items-center gap-1.5 flex-wrap"
      onClick={e => e.stopPropagation()}
    >
      {assignedCrew.map(c => (
        <span
          key={c.id}
          className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700"
        >
          {availabilityBadge(c.id)}
          {c.name}
          {!isDisabled && (
            <button
              onClick={() => handleRemove(c.id)}
              disabled={removing}
              className="ml-0.5 hover:text-red-600 transition-colors disabled:opacity-50"
              aria-label={`Remove ${c.name}`}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </span>
      ))}

      {!isDisabled && (
        <div className="relative">
          <button
            onClick={() => onOpenChange(!open)}
            disabled={adding}
            className={cn(
              'flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-all',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              assignedCrew.length === 0
                ? 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100'
                : 'border-themed text-muted-themed hover:text-secondary-themed'
            )}
          >
            <UserPlus className="w-3 h-3" />
            {adding ? '…' : assignedCrew.length === 0 ? 'Assign' : '+ Add'}
          </button>

          {open && available.length > 0 && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => onOpenChange(false)} />
              <div className="absolute left-0 top-full mt-1 z-20 bg-card-themed border border-themed rounded-xl shadow-card-lg py-1 min-w-[160px]">
                {available.map(c => (
                  <button
                    key={c.id}
                    onClick={() => handleAdd(c.id)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-canvas-themed transition-colors flex items-center gap-2"
                  >
                    <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
                      {c.name[0]?.toUpperCase()}
                    </span>
                    {c.name}
                    {availabilityBadge(c.id)}
                  </button>
                ))}
              </div>
            </>
          )}

          {open && available.length === 0 && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => onOpenChange(false)} />
              <div className="absolute left-0 top-full mt-1 z-20 bg-card-themed border border-themed rounded-xl shadow-card-lg p-3 min-w-[140px]">
                <p className="text-xs text-muted-themed">All crew assigned</p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Turnover Card ────────────────────────────────────────────────────────────

function TurnoverCard({
  turnover,
  property,
  crewMembers,
  isSelected,
  onToggle,
  onWarning,
}: Readonly<{
  turnover: Turnover
  property: Property | undefined
  crewMembers: CrewMember[]
  isSelected: boolean
  onToggle: () => void
  onWarning?: (msg: string) => void
}>) {
  const [expanded,        setExpanded]        = useState(false)
  const [assignOpen,      setAssignOpen]      = useState(false)
  const [updating,        startUpdate]        = useTransition()
  const [accepting,       startAccept]        = useTransition()
  const [dismissing,      startDismiss]       = useTransition()
  const [archiving,       startArchive]       = useTransition()
  const [flagNotes,       setFlagNotes]       = useState('')
  const [showFlagInput,   setShowFlagInput]   = useState(false)
  const [showQuickFlag,   setShowQuickFlag]   = useState(false)
  const [quickFlagNotes,  setQuickFlagNotes]  = useState('')
  const [flagPhotoFile,   setFlagPhotoFile]   = useState<File | null>(null)
  const [flagPhotoPreview,setFlagPhotoPreview]= useState<string | null>(null)
  const [quickFlagging,   setQuickFlagging]   = useState(false)
  const flagPhotoRef = useRef<HTMLInputElement | null>(null)

  const suggestedNames = (turnover.suggested_crew_ids ?? [])
    .map((id) => crewMembers.find((c) => c.id === id)?.name)
    .filter(Boolean) as string[]

  const handleAcceptSuggestion = (e: React.MouseEvent) => {
    e.stopPropagation()
    startAccept(async () => { await acceptSuggestion(turnover.id) })
  }

  const handleDismissSuggestion = (e: React.MouseEvent) => {
    e.stopPropagation()
    startDismiss(async () => { await dismissSuggestion(turnover.id) })
  }

  const propertyName = property?.name ?? 'Unknown Property'

  const handleFlagPhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    if (!file) return
    setFlagPhotoFile(file)
    setFlagPhotoPreview(URL.createObjectURL(file))
  }

  const handleQuickFlag = async () => {
    if (!quickFlagNotes.trim()) return
    setQuickFlagging(true)
    try {
      if (flagPhotoFile) {
        const supabase = createClient()
        const ext  = flagPhotoFile.name.split('.').pop() ?? 'jpg'
        const path = `turnover-${turnover.id}/flag-${Date.now()}.${ext}`
        await supabase.storage.from('turnover-photos').upload(path, flagPhotoFile, { upsert: true })
      }
      await updateTurnoverStatus(turnover.id, 'flagged', quickFlagNotes)
      setShowQuickFlag(false)
      setQuickFlagNotes('')
      setFlagPhotoFile(null)
      setFlagPhotoPreview(null)
    } finally {
      setQuickFlagging(false)
    }
  }

  const checkout     = new Date(turnover.checkout_datetime)
  const checkin      = new Date(turnover.checkin_datetime)
  const assignedCrew = getAllAssignedCrew(turnover)
  const isOverdue    = isPast(checkout) && turnover.status !== 'completed' && turnover.status !== 'in_progress'
  const windowMins   = turnover.window_minutes ?? 0
  const windowColor  =
    windowMins < 120 ? 'text-red-600'   :
    windowMins < 240 ? 'text-amber-600' :
    windowMins < 480 ? 'text-blue-600'  : 'text-green-600'

  const duration = formatDuration(turnover.started_at, turnover.completed_at)

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
        'bg-card-themed rounded-xl border transition-shadow',
        isOverdue          ? 'border-red-200 shadow-[0_0_0_1px_#fca5a5]' :
        turnover.priority === 'urgent' ? 'border-red-200' :
        turnover.priority === 'high'   ? 'border-amber-200' :
        'border-themed',
        'hover:shadow-card-md'
      )}
    >
      {/* Card header — always visible */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        {/* Bulk-select checkbox */}
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          onClick={e => e.stopPropagation()}
          className="w-4 h-4 rounded border-themed text-brand-600 focus:ring-brand-500 mt-0.5 flex-shrink-0 cursor-pointer"
          aria-label="Select turnover"
        />

        {/* Priority / overdue indicator */}
        <div className={cn(
          'w-1 self-stretch rounded-full flex-shrink-0',
          isOverdue              ? 'bg-red-500' :
          turnover.priority === 'urgent' ? 'bg-red-400' :
          turnover.priority === 'high'   ? 'bg-amber-400' :
          turnover.priority === 'medium' ? 'bg-blue-300' : 'bg-raised-themed'
        )} />

        <div className="flex-1 min-w-0">
          {/* Property + status */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-primary-themed text-sm">
              {property?.name ?? 'Unknown Property'}
            </span>
            {property?.city && (
              <span className="text-xs text-muted-themed">{property.city}</span>
            )}
            {turnover.status === 'pending_assignment' ? (
              <button
                onClick={(e) => { e.stopPropagation(); setAssignOpen(true) }}
                className={cn(statusBadge(turnover.status), 'cursor-pointer hover:brightness-95')}
                title="Click to assign crew"
              >
                {TURNOVER_STATUS_LABELS.pending_assignment}
              </button>
            ) : (
              <span className={statusBadge(turnover.status)}>
                {TURNOVER_STATUS_LABELS[turnover.status as keyof typeof TURNOVER_STATUS_LABELS] ?? turnover.status}
              </span>
            )}
            {isOverdue && (
              <span className="badge badge-red flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" /> Overdue
              </span>
            )}
          </div>

          {/* Times + window */}
          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-themed">
            <span>
              <span className="font-medium text-secondary-themed">Out:</span>{' '}
              {checkout.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}{' '}
              {checkout.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </span>
            <span className="text-muted-themed">→</span>
            <span>
              <span className="font-medium text-secondary-themed">In:</span>{' '}
              {checkin.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              {checkin.toDateString() !== checkout.toDateString() && (
                <span className="text-muted-themed ml-1">
                  ({checkin.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
                </span>
              )}
            </span>
            <span className={cn('font-semibold flex items-center gap-0.5', windowColor)}>
              <Clock className="w-3 h-3" />
              {formatWindow(windowMins)}
            </span>
          </div>

          {/* Auto-assignment suggestion banner */}
          {turnover.suggestion_status === 'pending' && suggestedNames.length > 0 && (
            <div
              className="mt-2 flex items-center gap-2 flex-wrap px-3 py-2 rounded-lg"
              style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                ✨ Suggested: <strong style={{ color: 'var(--text-primary)' }}>{suggestedNames.join(', ')}</strong>
              </span>
              {turnover.suggestion_reasoning && (
                <span className="text-xs hidden sm:inline" style={{ color: 'var(--text-muted)' }}>
                  — {turnover.suggestion_reasoning}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={handleAcceptSuggestion}
                  disabled={accepting || dismissing}
                  className="text-xs px-2.5 py-1 rounded-lg font-medium disabled:opacity-50 transition-colors"
                  style={{ background: 'var(--accent-green)', color: '#fff' }}
                >
                  {accepting ? '…' : '✓ Accept'}
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

        {/* Crew chips + quick-flag + expand */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <CrewAssignment
            turnover={turnover}
            crewMembers={crewMembers}
            assignedCrew={assignedCrew}
            onWarning={onWarning}
            open={assignOpen}
            onOpenChange={setAssignOpen}
          />
          {turnover.status !== 'completed' && turnover.status !== 'cancelled' && (
            <button
              onClick={e => { e.stopPropagation(); setShowQuickFlag(true) }}
              className="p-1.5 rounded-lg transition-colors flex-shrink-0"
              style={{ color: 'var(--text-muted)' }}
              title="Flag an issue"
              aria-label="Flag issue"
            >
              <Flag className="w-4 h-4" />
            </button>
          )}
          <ChevronDown className={cn('w-4 h-4 text-muted-themed transition-transform', expanded && 'rotate-180')} />
        </div>
      </div>

      {/* Quick-flag bottom sheet */}
      {showQuickFlag && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setShowQuickFlag(false)}
        >
          <div
            className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 pb-8 sm:pb-5"
            style={{ background: 'var(--bg-card)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                Flag Issue — {propertyName}
              </h4>
              <button onClick={() => setShowQuickFlag(false)} className="btn-ghost p-1.5">
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              value={quickFlagNotes}
              onChange={e => setQuickFlagNotes(e.target.value)}
              rows={3}
              className="input resize-none w-full text-sm"
              placeholder="Describe the issue…"
              autoFocus
            />

            <div className="mt-3">
              <input
                ref={flagPhotoRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={handleFlagPhotoSelect}
              />
              {flagPhotoPreview ? (
                <div className="relative w-20 h-20 rounded-lg overflow-hidden border border-themed">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={flagPhotoPreview} alt="Flag photo" className="w-full h-full object-cover" />
                  <button
                    onClick={() => { setFlagPhotoPreview(null); setFlagPhotoFile(null) }}
                    className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center"
                  >
                    <X className="w-3 h-3 text-white" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => flagPhotoRef.current?.click()}
                  className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border-dashed border-2 border-themed w-full justify-center transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Camera className="w-4 h-4" />
                  Add Photo (optional)
                </button>
              )}
            </div>

            <div className="flex gap-2 mt-4">
              <button
                onClick={handleQuickFlag}
                disabled={!quickFlagNotes.trim() || quickFlagging}
                className="btn-danger flex-1 text-sm"
              >
                {quickFlagging ? 'Flagging…' : 'Flag Issue'}
              </button>
              <button onClick={() => setShowQuickFlag(false)} className="btn-ghost text-sm">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-themed p-4 space-y-4">
          {turnover.notes && (
            <p className="text-sm text-secondary-themed bg-canvas-themed rounded-lg px-3 py-2">
              {turnover.notes}
            </p>
          )}

          {/* Flag notes input */}
          {showFlagInput && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-secondary-themed">What needs attention?</label>
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

          {turnover.status === 'completed' && (
            <div className="flex items-center gap-3 flex-wrap">
              {turnover.completed_at && (
                <p className="text-xs flex items-center gap-1 text-green-600">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Completed {new Date(turnover.completed_at).toLocaleString()}
                </p>
              )}
              {duration && (
                <span
                  className="text-xs font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}
                >
                  ⏱ {duration}
                </span>
              )}
              {turnover.is_archived ? (
                <button
                  onClick={() => startArchive(async () => { await unarchiveTurnover([turnover.id]) })}
                  disabled={archiving}
                  className="btn-ghost text-xs py-1.5 ml-auto disabled:opacity-50"
                  style={{ color: 'var(--accent-gold)' }}
                >
                  {archiving ? 'Restoring…' : 'Unarchive'}
                </button>
              ) : (
                <button
                  onClick={() => startArchive(async () => { await archiveTurnover([turnover.id]) })}
                  disabled={archiving}
                  className="btn-ghost text-xs py-1.5 ml-auto text-muted-themed disabled:opacity-50"
                >
                  {archiving ? 'Archiving…' : 'Archive'}
                </button>
              )}
            </div>
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
  forceOpen = false,
  variant = 'default',
  selectedIds,
  onToggle,
  onWarning,
}: Readonly<{
  label: string
  turnovers: Turnover[]
  propertyMap: Record<string, Property>
  crewMembers: CrewMember[]
  defaultOpen?: boolean
  forceOpen?: boolean
  variant?: 'default' | 'urgent' | 'muted'
  selectedIds: Set<string>
  onToggle: (id: string) => void
  onWarning?: (msg: string) => void
}>) {
  const [open, setOpen] = useState(defaultOpen)
  const prevLengthRef = useRef(turnovers.length)

  // This section's mounted instance persists across filter/tab changes (it's
  // always rendered, just conditionally returns null below), so `open` can go
  // stale relative to `defaultOpen`/`forceOpen` — re-evaluate on every change
  // instead of trusting the useState initial value alone.
  useEffect(() => {
    const becameNonEmpty = prevLengthRef.current === 0 && turnovers.length > 0
    prevLengthRef.current = turnovers.length
    if (becameNonEmpty || forceOpen) setOpen(true)
  }, [turnovers.length, forceOpen])

  if (!turnovers.length) return null

  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 mb-3 group w-full text-left"
      >
        <span className={cn(
          'text-sm font-semibold transition-colors',
          variant === 'urgent' ? 'text-red-600' :
          variant === 'muted'  ? 'text-muted-themed' : 'text-secondary-themed group-hover:text-primary-themed'
        )}>
          {label}
        </span>
        <span className={cn(
          'badge text-xs',
          variant === 'urgent' ? 'bg-red-50 text-red-600' : 'badge-slate'
        )}>
          {turnovers.length}
        </span>
        <ChevronDown className={cn('w-4 h-4 text-muted-themed ml-auto transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-3">
          {turnovers.map((t) => (
            <TurnoverCard
              key={t.id}
              turnover={t}
              property={propertyMap[t.property_id]}
              crewMembers={crewMembers}
              isSelected={selectedIds.has(t.id)}
              onToggle={() => onToggle(t.id)}
              onWarning={onWarning}
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
}: Readonly<{
  properties: Property[]
  onClose: () => void
}>) {
  const [state, action, pending] = useActionState(createManualTurnover, null)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-card-themed rounded-2xl shadow-card-lg w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-primary-themed">Add Turnover</h3>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Checkout Date</label>
              <input name="checkout_date" type="date" required className="input" />
            </div>
            <div>
              <label className="label">Checkout Time</label>
              <input name="checkout_time" type="time" defaultValue="11:00" className="input" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

// ── Split Assign Modal ───────────────────────────────────────────────────────

function SplitAssignModal({
  turnoverIds,
  turnovers,
  propertyMap,
  crewMembers,
  onClose,
  onApplied,
}: Readonly<{
  turnoverIds: string[]
  turnovers:   Turnover[]
  propertyMap: Record<string, Property>
  crewMembers: CrewMember[]
  onClose:     () => void
  onApplied:   (warning?: string) => void
}>) {
  const selected = turnovers.filter(t => turnoverIds.includes(t.id))

  const [picks, setPicks] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const t of selected) {
      if (t.suggested_crew_ids?.[0]) initial[t.id] = t.suggested_crew_ids[0]
    }
    return initial
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]           = useState<string | null>(null)

  const pickedCount = Object.values(picks).filter(Boolean).length

  const handleApply = async () => {
    setSubmitting(true)
    setError(null)
    const assignments = selected
      .filter(t => picks[t.id])
      .map(t => ({ turnoverId: t.id, crewMemberId: picks[t.id]! }))

    const result = await assignCrewIndividually(assignments)
    setSubmitting(false)

    if (result.error) {
      setError(result.error)
      return
    }
    onApplied(result.warning)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-card-themed rounded-2xl shadow-card-lg w-full max-w-lg p-6 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-primary-themed">Assign Individually</h3>
            <p className="text-xs text-muted-themed mt-0.5">
              {selected.length} turnovers — pick a crew member for each
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4 flex-shrink-0">
            {error}
          </div>
        )}

        <div className="overflow-y-auto flex-1 space-y-2 -mx-1 px-1">
          {selected.map(t => {
            const property = propertyMap[t.property_id]
            const date = new Date(t.checkout_datetime).toLocaleDateString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric',
            })
            return (
              <div
                key={t.id}
                className="flex items-center justify-between gap-3 py-2 px-3 rounded-xl"
                style={{ background: 'var(--bg-raised)' }}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {property?.name ?? 'Unknown property'}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{date}</p>
                </div>
                <select
                  className="input text-sm py-1.5 flex-shrink-0"
                  style={{ maxWidth: '160px' }}
                  value={picks[t.id] ?? ''}
                  onChange={e => setPicks(prev => ({ ...prev, [t.id]: e.target.value }))}
                >
                  <option value="">Unassigned</option>
                  {crewMembers.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-themed flex-shrink-0">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {pickedCount} of {selected.length} assigned
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
            <button
              onClick={handleApply}
              disabled={submitting || pickedCount === 0}
              className="btn-primary text-sm"
            >
              {submitting ? 'Applying…' : 'Apply Assignments'}
            </button>
          </div>
        </div>
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
  bookings = [],
  crewAvailability = [],
  orgId,
  showAutoAssignNudge = false,
}: Readonly<{
  turnovers: Turnover[]
  propertyMap: Record<string, Property>
  crewMembers: CrewMember[]
  properties: Property[]
  bookings?: BookingRow[]
  crewAvailability?: CrewAvailabilityRow[]
  orgId: string
  showAutoAssignNudge?: boolean
}>) {
  const searchParams = useSearchParams()
  const urlStatus    = searchParams.get('status')

  const [showAdd,           setShowAdd]           = useState(false)
  const [splitAssignOpen,   setSplitAssignOpen]   = useState(false)
  const [syncing,           startSync]            = useTransition()
  const [filterProp,        setFilterProp]        = useState<string>('all')
  const [filterStatus,      setFilterStatus]      = useState<string>(
    urlStatus === 'pending_assignment' ? 'active' : 'active'
  )
  const [filterCrew,        setFilterCrew]        = useState<string>('all')
  const [showArchived,      setShowArchived]      = useState(false)
  const [selectedIds,       setSelectedIds]       = useState<Set<string>>(new Set())
  const [bulkAssigning,     startBulkAssign]      = useTransition()
  const [viewMode,          setViewMode]          = useState<'list' | 'gantt'>('list')
  const [assignmentWarning, setAssignmentWarning] = useState<string | null>(null)

  useEffect(() => {
    if (!assignmentWarning) return
    const t = setTimeout(() => setAssignmentWarning(null), 5000)
    return () => clearTimeout(t)
  }, [assignmentWarning])

  const toggleSelect = (id: string) =>
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const clearSelection = () => setSelectedIds(new Set())

  const availabilityMap = useMemo(() => {
    const map: Record<string, boolean> = {}
    for (const row of crewAvailability) {
      map[`${row.crew_member_id}::${row.available_date}`] = row.is_available
    }
    return map
  }, [crewAvailability])

  // Filter
  const filtered = turnovers.filter((t) => {
    // Archived turnovers are hidden from the default board and only shown
    // when the "Show Archived" toggle is active (which shows ONLY archived).
    if (showArchived ? !t.is_archived : t.is_archived) return false

    if (filterProp !== 'all' && t.property_id !== filterProp) return false

    // In archived view every row is already completed, so the active/completed
    // status tabs don't apply — skip them to avoid filtering archived rows out.
    if (!showArchived) {
      if (filterStatus === 'active'    && (t.status === 'completed' || t.status === 'cancelled')) return false
      if (filterStatus === 'completed' &&  t.status !== 'completed') return false
    }

    if (filterCrew !== 'all') {
      const crewIds = t.turnover_assignments.map(a => a.crew_member_id)

      if (filterCrew === 'unassigned') {
        if (t.status !== 'pending_assignment') return false
      } else {
        if (!crewIds.includes(filterCrew)) return false
      }
    }

    return true
  })

  const allVisibleSelected =
    filtered.length > 0 && filtered.every(t => selectedIds.has(t.id))

  const toggleSelectAll = () =>
    allVisibleSelected
      ? clearSelection()
      : setSelectedIds(new Set(filtered.map(t => t.id)))

  const groups = groupTurnovers(filtered)

  const hasUrgentVisibleContent =
    groups.urgent.length > 0 || groups.today.length > 0 ||
    groups.tomorrow.length > 0 || groups.week.length > 0

  // If nothing in the "always open" sections has content, force Upcoming
  // open even though its own default might otherwise be false — a PM
  // should never load this page and see nothing.
  const upcomingForceOpen = !hasUrgentVisibleContent && groups.upcoming.length > 0

  const totalActive = turnovers.filter((t) =>
    t.status !== 'completed' && t.status !== 'cancelled'
  ).length

  const needsCrew = turnovers.filter((t) =>
    t.status === 'pending_assignment'
  ).length

  return (
    <CrewAvailabilityContext.Provider value={availabilityMap}>
      {/* Conflict warning toast */}
      {assignmentWarning && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 text-sm"
          style={{
            background: 'var(--accent-amber-dim)',
            border:     '1px solid var(--accent-amber)',
            color:      'var(--accent-amber)',
          }}
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {assignmentWarning}
          <button onClick={() => setAssignmentWarning(null)} className="ml-2">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {showAutoAssignNudge && (
        <NudgeBanner
          id="auto-assign-intro"
          message="FieldStay can assign crews automatically based on availability and distance."
          href="/settings?tab=automation"
          linkText="Enable auto-assignment"
        />
      )}

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
            onClick={() => startSync(() => triggerManualSync())}
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

      {/* Filters + view toggle */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-1.5 bg-card-themed border border-themed rounded-lg px-1 py-1">
          {(['active', 'completed', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize',
                filterStatus !== s && 'text-muted-themed hover:text-secondary-themed'
              )}
              style={filterStatus === s ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
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

        {crewMembers.length > 0 && (
          <select
            value={filterCrew}
            onChange={e => setFilterCrew(e.target.value)}
            className="input text-sm py-1.5 w-auto"
          >
            <option value="all">All Crew</option>
            <option value="unassigned">🔴 Unassigned only</option>
            {crewMembers.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}

        <button
          onClick={() => setShowArchived((s) => !s)}
          className={cn(
            'text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors',
            showArchived ? '' : 'text-muted-themed hover:text-secondary-themed'
          )}
          style={
            showArchived
              ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)', borderColor: 'var(--accent-gold)' }
              : { borderColor: 'var(--border)' }
          }
          title="Toggle archived turnovers"
        >
          {showArchived ? 'Hide Archived' : 'Show Archived'}
        </button>

        {/* List / Gantt toggle */}
        <div
          className="flex items-center gap-0.5 rounded-lg p-0.5 ml-auto"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
        >
          <button
            onClick={() => setViewMode('list')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs
                       font-medium transition-colors"
            style={{
              background: viewMode === 'list' ? 'var(--bg-card)' : 'transparent',
              color:      viewMode === 'list' ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow:  viewMode === 'list' ? '0 1px 2px rgba(0,0,0,0.15)' : 'none',
            }}
            title="List view"
          >
            <LayoutList className="w-3.5 h-3.5" />
            List
          </button>
          <button
            onClick={() => setViewMode('gantt')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs
                       font-medium transition-colors"
            style={{
              background: viewMode === 'gantt' ? 'var(--bg-card)' : 'transparent',
              color:      viewMode === 'gantt' ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow:  viewMode === 'gantt' ? '0 1px 2px rgba(0,0,0,0.15)' : 'none',
            }}
            title="Gantt view"
          >
            <GanttChartSquare className="w-3.5 h-3.5" />
            Gantt
          </button>
        </div>
      </div>

      {/* Select-all row */}
      {filtered.length > 1 && (
        <div className="flex items-center gap-3 mb-2">
          <label className="flex items-center gap-2 text-xs cursor-pointer"
                 style={{ color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded border-themed text-brand-600"
            />
            {allVisibleSelected
              ? `Deselect all (${filtered.length})`
              : `Select all visible (${filtered.length})`}
          </label>
        </div>
      )}

      {/* Board */}
      {viewMode === 'gantt' ? (
        <TurnoverGantt
          turnovers={filtered}
          properties={properties}
          bookings={bookings}
        />
      ) : (
        /* existing full list-view render block unchanged */
        <div>
          {filtered.length === 0 ? (
            <div className="card text-center py-16 max-w-md mx-auto mt-4">
              <CalendarCheck className="w-10 h-10 text-muted-themed mx-auto mb-3" />
              <h3 className="font-semibold text-secondary-themed mb-1">No turnovers found</h3>
              <p className="text-sm text-muted-themed">
                {turnovers.length === 0
                  ? 'Add a property and connect your calendar to start seeing turnovers here.'
                  : 'No turnovers match the current filter.'
                }
              </p>
            </div>
          ) : (
            <>
              <BoardSection
                label="🚨 Needs Attention"
                turnovers={groups.urgent}
                propertyMap={propertyMap}
                crewMembers={crewMembers}
                variant="urgent"
                selectedIds={selectedIds}
                onToggle={toggleSelect}
                onWarning={setAssignmentWarning}
              />
              <BoardSection
                label="Today"
                turnovers={groups.today}
                propertyMap={propertyMap}
                crewMembers={crewMembers}
                selectedIds={selectedIds}
                onToggle={toggleSelect}
                onWarning={setAssignmentWarning}
              />
              <BoardSection
                label="Tomorrow"
                turnovers={groups.tomorrow}
                propertyMap={propertyMap}
                crewMembers={crewMembers}
                selectedIds={selectedIds}
                onToggle={toggleSelect}
                onWarning={setAssignmentWarning}
              />
              <BoardSection
                label="This Week"
                turnovers={groups.week}
                propertyMap={propertyMap}
                crewMembers={crewMembers}
                selectedIds={selectedIds}
                onToggle={toggleSelect}
                onWarning={setAssignmentWarning}
              />
              <BoardSection
                label="Upcoming"
                turnovers={groups.upcoming}
                propertyMap={propertyMap}
                crewMembers={crewMembers}
                defaultOpen={true}
                forceOpen={upcomingForceOpen}
                selectedIds={selectedIds}
                onToggle={toggleSelect}
                onWarning={setAssignmentWarning}
              />
              {(filterStatus !== 'active' || showArchived) && (
                <BoardSection
                  label={showArchived ? 'Archived' : 'Recently Completed'}
                  turnovers={groups.recent}
                  propertyMap={propertyMap}
                  crewMembers={crewMembers}
                  defaultOpen={showArchived}
                  variant="muted"
                  selectedIds={selectedIds}
                  onToggle={toggleSelect}
                  onWarning={setAssignmentWarning}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Sticky bulk assignment bar */}
      {selectedIds.size > 0 && (
        <div
          className="fixed bottom-20 md:bottom-6 left-4 right-4 md:left-1/2 md:-translate-x-1/2 md:w-auto z-30 flex items-center justify-between gap-3 px-4 py-3 rounded-2xl shadow-xl"
          style={{
            background: 'var(--bg-card)',
            border:     '1px solid var(--border)',
            maxWidth:   '480px',
            margin:     '0 auto',
          }}
        >
          <span className="text-sm font-semibold flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
            {selectedIds.size} selected
          </span>

          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
              Assign to:
            </span>
            <select
              className="input text-sm py-1.5 flex-1"
              defaultValue=""
              disabled={bulkAssigning}
              onChange={async e => {
                if (!e.target.value) return
                const crewId = e.target.value
                e.target.value = ''
                startBulkAssign(async () => {
                  await assignCrew([...selectedIds], crewId)
                  clearSelection()
                })
              }}
            >
              <option value="" disabled>Choose crew member…</option>
              {crewMembers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <button
            disabled={bulkAssigning}
            onClick={() =>
              startBulkAssign(async () => {
                await bulkUpdateTurnoverStatus([...selectedIds], 'completed')
                clearSelection()
              })
            }
            className="btn-secondary text-xs flex-shrink-0 flex items-center gap-1"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Mark Complete
          </button>

          {selectedIds.size > 1 && (
            <button
              onClick={() => setSplitAssignOpen(true)}
              className="btn-ghost text-xs flex-shrink-0"
              style={{ color: 'var(--accent-gold)' }}
            >
              Split assign…
            </button>
          )}

          <button
            onClick={clearSelection}
            className="btn-ghost text-xs flex-shrink-0 flex items-center gap-1"
            style={{ color: 'var(--text-muted)' }}
          >
            <X className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      )}

      {/* Add turnover modal */}
      {showAdd && (
        <AddTurnoverModal
          properties={properties}
          onClose={() => setShowAdd(false)}
        />
      )}

      {splitAssignOpen && (
        <SplitAssignModal
          turnoverIds={[...selectedIds]}
          turnovers={turnovers}
          propertyMap={propertyMap}
          crewMembers={crewMembers}
          onClose={() => setSplitAssignOpen(false)}
          onApplied={(warning) => {
            setSplitAssignOpen(false)
            clearSelection()
            if (warning) setAssignmentWarning(warning)
          }}
        />
      )}
    </CrewAvailabilityContext.Provider>
  )
}
