'use client'

import { useState, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb, useDexieUserId } from '@/lib/dexie/context'
import { saveCrewAvailability } from '@/lib/dexie/helpers'
import { ChevronLeft, ChevronRight, XCircle, CheckCircle2 } from 'lucide-react'

interface Props {
  crewMemberId: string
  orgId:        string
}

type AvailRow = {
  id:             string
  available_date: string
  is_available:   number   // 1 = available, 0 = not
  notes:          string | null
}

export function TimeOffRequest({ crewMemberId, orgId }: Props) {
  const db     = useDexieDb()
  const userId = useDexieUserId()

  const [weekOffset, setWeekOffset] = useState(0) // 0 = current week, 1 = next, -1 = prev

  // Build 7-day window starting tomorrow + (weekOffset * 7) days
  const { days, windowStart, windowEnd } = useMemo(() => {
    const start = new Date()
    start.setDate(start.getDate() + 1 + (weekOffset * 7))
    start.setHours(0, 0, 0, 0)

    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      return d
    })

    return {
      days,
      windowStart: days[0]!.toISOString().slice(0, 10),
      windowEnd:   days[6]!.toISOString().slice(0, 10),
    }
  }, [weekOffset])

  // Read existing availability records for this window from the local cache
  const existingRows = useLiveQuery(
    () => db.crew_availability
      .where('crew_member_id').equals(crewMemberId)
      .filter((r) => r.available_date >= windowStart && r.available_date <= windowEnd)
      .toArray() as unknown as Promise<AvailRow[]>,
    [crewMemberId, windowStart, windowEnd]
  )

  // Read upcoming time-off records beyond the 7-day window (for the list below)
  const upcomingTimeOff = useLiveQuery(
    () => db.crew_availability
      .where('crew_member_id').equals(crewMemberId)
      .filter((r) => r.available_date > windowEnd && r.is_available === 0)
      .sortBy('available_date') as unknown as Promise<AvailRow[]>,
    [crewMemberId, windowEnd]
  )

  // Local draft state — what the crew member has selected but not yet saved
  // Key: YYYY-MM-DD, Value: { timeOff: boolean, note: string }
  const [draft, setDraft] = useState<Record<string, { timeOff: boolean; note: string }>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  // Clear unsaved draft changes when navigating to a different week — compared
  // during render rather than in a useEffect so it lands in the same render pass.
  const [prevWeekOffset, setPrevWeekOffset] = useState(weekOffset)
  if (weekOffset !== prevWeekOffset) {
    setPrevWeekOffset(weekOffset)
    setDraft({})
  }

  const existingMap = useMemo(() => {
    const m = new Map<string, AvailRow>()
    for (const row of existingRows ?? []) m.set(row.available_date, row)
    return m
  }, [existingRows])

  const formatDay = (d: Date): string =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })

  const isoDate = (d: Date): string => d.toISOString().slice(0, 10)

  const toggleDay = (dateStr: string) => {
    setDraft(prev => {
      const existing    = existingMap.get(dateStr)
      const currentDraft = prev[dateStr]

      if (currentDraft) {
        // Already in draft — remove it (revert to whatever exists in DB)
        const next = { ...prev }
        delete next[dateStr]
        return next
      }

      // Add to draft — flip from whatever the current DB state is
      const dbIsTimeOff = existing ? existing.is_available === 0 : false
      return {
        ...prev,
        [dateStr]: {
          timeOff: !dbIsTimeOff,
          note:    existing?.notes ?? '',
        },
      }
    })
  }

  const updateNote = (dateStr: string, note: string) => {
    setDraft(prev => ({
      ...prev,
      [dateStr]: { ...prev[dateStr], note },
    }))
  }

  const saveChanges = async () => {
    setSaving(true)
    setSaveError(null)

    try {
      for (const [dateStr, change] of Object.entries(draft)) {
        const existing = existingMap.get(dateStr)

        await saveCrewAvailability(userId, {
          id:           existing?.id,
          orgId,
          crewMemberId,
          date:         dateStr,
          isAvailable:  !change.timeOff,
          notes:        change.note || null,
        })
      }

      setDraft({})
      setSavedAt(new Date())
    } catch (err) {
      setSaveError('Failed to save — please try again')
      console.error('[TimeOffRequest] save error:', err)
    } finally {
      setSaving(false)
    }
  }

  const cancelUpcoming = async (row: AvailRow) => {
    setCancellingId(row.id)
    setCancelError(null)
    try {
      await saveCrewAvailability(userId, {
        id:           row.id,
        orgId,
        crewMemberId,
        date:         row.available_date,
        isAvailable:  true,
        notes:        null,
      })
    } catch (err) {
      setCancelError('Failed to cancel — please try again')
      console.error('[TimeOffRequest] cancel error:', err)
    } finally {
      setCancellingId(null)
    }
  }

  const hasDraftChanges = Object.keys(draft).length > 0

  return (
    <div className="space-y-6 pb-24">
      <div>
        <h2 className="text-lg font-bold text-accent-900 mb-1">Time Off Request</h2>
        <p className="text-sm text-accent-500 mb-4">
          Tap any day to mark it as time off. Add a note if needed. Tap Save when done.
        </p>

        {/* Week navigation */}
        <div className="flex items-center justify-between mt-4 mb-2">
          <button
            onClick={() => setWeekOffset(w => w - 1)}
            className="flex items-center gap-1 text-sm font-medium text-accent-600
                       hover:text-accent-900 px-3 py-2 rounded-lg hover:bg-accent-100
                       transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Prev Week
          </button>

          <span className="text-sm font-semibold text-accent-700">
            {new Date(windowStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            {' – '}
            {new Date(windowEnd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>

          <button
            onClick={() => setWeekOffset(w => w + 1)}
            className="flex items-center gap-1 text-sm font-medium text-accent-600
                       hover:text-accent-900 px-3 py-2 rounded-lg hover:bg-accent-100
                       transition-colors"
          >
            Next Week
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 7-day list */}
      <div className="space-y-2">
        {days.map((day) => {
          const dateStr   = isoDate(day)
          const existing  = existingMap.get(dateStr)
          const draftItem = draft[dateStr]

          // Resolve effective state: draft takes priority over DB
          const isTimeOff = draftItem
            ? draftItem.timeOff
            : existing
            ? existing.is_available === 0
            : false

          const noteValue = draftItem?.note ?? existing?.notes ?? ''
          const isInDraft = !!draftItem

          return (
            <div
              key={dateStr}
              className={`rounded-xl border transition-all ${
                isTimeOff
                  ? 'bg-amber-500/10 border-amber-500/30'
                  : 'bg-surface-card border-transparent'
              }`}
            >
              <button
                onClick={() => toggleDay(dateStr)}
                className="w-full flex items-center justify-between px-4 py-3"
              >
                <span className={`text-sm font-semibold ${
                  isTimeOff ? 'text-amber-400 line-through' : 'text-white'
                }`}>
                  {formatDay(day)}
                </span>
                <span>
                  {isTimeOff
                    ? <XCircle className="w-5 h-5 text-amber-400" />
                    : <CheckCircle2 className="w-5 h-5 text-green-400" />
                  }
                </span>
              </button>

              {/* Note input — only visible when time off is toggled */}
              {isTimeOff && (
                <div className="px-4 pb-3">
                  <input
                    type="text"
                    placeholder="Reason (optional)"
                    value={noteValue}
                    onChange={(e) => {
                      // Ensure this date is in draft before updating note
                      if (!isInDraft) {
                        setDraft(prev => ({
                          ...prev,
                          [dateStr]: { timeOff: true, note: e.target.value },
                        }))
                      } else {
                        updateNote(dateStr, e.target.value)
                      }
                    }}
                    className="w-full bg-surface-raised border border-accent-600 rounded-lg
                               px-3 py-2 text-sm text-white placeholder:text-accent-500
                               focus:outline-none focus:border-brand-400"
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Save button */}
      {hasDraftChanges && (
        <div className="fixed bottom-20 left-0 right-0 px-4">
          <button
            onClick={saveChanges}
            disabled={saving}
            className="w-full py-3 rounded-xl bg-brand-400 text-surface-base font-bold
                       text-sm disabled:opacity-60 active:scale-95 transition-all"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          {saveError && (
            <p className="text-xs text-red-400 text-center mt-2">{saveError}</p>
          )}
        </div>
      )}

      {savedAt && !hasDraftChanges && (
        <p className="text-xs text-green-400 text-center">
          Your availability has been updated. Your manager&apos;s calendar will reflect this shortly.
        </p>
      )}

      {/* Upcoming time off (beyond the 14-day window) */}
      {(upcomingTimeOff?.length ?? 0) > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-accent-400 uppercase tracking-wide mb-3">
            Upcoming Time Off
          </h3>
          <div className="space-y-2">
            {upcomingTimeOff?.map((row) => (
              <div
                key={row.id}
                className="flex items-center justify-between bg-surface-card
                           rounded-xl px-4 py-3 border border-amber-500/20"
              >
                <div>
                  <p className="text-sm font-semibold text-amber-400">
                    {new Date(row.available_date + 'T00:00:00').toLocaleDateString(
                      'en-US', { month: 'short', day: 'numeric', weekday: 'short' }
                    )}
                  </p>
                  {row.notes && (
                    <p className="text-xs text-accent-400 mt-0.5">{row.notes}</p>
                  )}
                </div>
                <button
                  onClick={() => cancelUpcoming(row)}
                  disabled={cancellingId === row.id}
                  className="text-xs text-accent-500 underline disabled:opacity-50"
                >
                  {cancellingId === row.id ? 'Cancelling…' : 'Cancel'}
                </button>
              </div>
            ))}
          </div>
          {cancelError && (
            <p className="text-xs text-red-400 text-center mt-2">{cancelError}</p>
          )}
        </div>
      )}
    </div>
  )
}
