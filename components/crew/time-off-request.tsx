'use client'

import { useState, useMemo }     from 'react'
import { usePowerSync, usePowerSyncQuery } from '@powersync/react'
import { XCircle, CheckCircle2 } from 'lucide-react'

interface Props {
  crewMemberId: string
  orgId:        string
}

type AvailRow = {
  id:             string
  available_date: string
  is_available:   number   // PowerSync SQLite: 1 = available, 0 = not
  notes:          string | null
}

export function TimeOffRequest({ crewMemberId, orgId }: Props) {
  const db = usePowerSync()

  // Build 14-day window starting tomorrow
  const days = useMemo(() => {
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date()
      d.setDate(d.getDate() + i + 1)
      d.setHours(0, 0, 0, 0)
      return d
    })
  }, [])

  const windowStart = days[0].toISOString().slice(0, 10)
  const windowEnd   = days[13].toISOString().slice(0, 10)

  // Read existing availability records for this window from local SQLite
  const existingRows = usePowerSyncQuery<AvailRow>(
    `SELECT id, available_date, is_available, notes
     FROM crew_availability
     WHERE crew_member_id = ?
       AND available_date >= ?
       AND available_date <= ?`,
    [crewMemberId, windowStart, windowEnd]
  )

  // Read upcoming time-off records beyond the 14-day window (for the list below)
  const upcomingTimeOff = usePowerSyncQuery<AvailRow>(
    `SELECT id, available_date, is_available, notes
     FROM crew_availability
     WHERE crew_member_id = ?
       AND available_date > ?
       AND is_available = 0
     ORDER BY available_date ASC`,
    [crewMemberId, windowEnd]
  )

  // Local draft state — what the crew member has selected but not yet saved
  // Key: YYYY-MM-DD, Value: { timeOff: boolean, note: string }
  const [draft, setDraft] = useState<Record<string, { timeOff: boolean; note: string }>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)

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
        const newIsAvailable = change.timeOff ? 0 : 1

        if (existing) {
          // UPDATE existing row
          await db.execute(
            `UPDATE crew_availability
             SET is_available = ?, notes = ?
             WHERE id = ?`,
            [newIsAvailable, change.note || null, existing.id]
          )
        } else {
          // INSERT new row — UUID generated via SQLite randomblob (gen_random_uuid() is Postgres-only)
          await db.execute(
            `INSERT INTO crew_availability (id, org_id, crew_member_id, available_date, is_available, notes, created_at)
             VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))), ?, ?, ?, ?, ?, datetime('now'))`,
            [orgId, crewMemberId, dateStr, newIsAvailable, change.note || null]
          )
        }
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
    await db.execute(
      `UPDATE crew_availability SET is_available = 1, notes = null WHERE id = ?`,
      [row.id]
    )
  }

  const hasDraftChanges = Object.keys(draft).length > 0

  return (
    <div className="space-y-6 pb-24">
      <div>
        <h2 className="text-lg font-bold text-white mb-1">Time Off Request</h2>
        <p className="text-sm text-accent-400">
          Tap any day to mark it as time off. Add a note if needed. Tap Save when done.
        </p>
      </div>

      {/* 14-day list */}
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
                  className="text-xs text-accent-500 underline"
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
