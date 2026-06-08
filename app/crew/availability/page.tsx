'use client'
import { useState, useEffect, useRef, useCallback, useTransition } from 'react'
import { ChevronLeft, ChevronRight, Check, X as XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMyAvailability, setCrewAvailability, type AvailabilityDay } from './actions'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const LONG_PRESS_MS = 550

function pad(n: number) { return n.toString().padStart(2, '0') }
function toDateStr(year: number, month: number, day: number) {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

export default function CrewAvailabilityPage() {
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })
  const [days, setDays]           = useState<Record<string, AvailabilityDay>>({})
  const [loading, setLoading]     = useState(true)
  const [notesDate, setNotesDate] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState('')
  const [, startSave]             = useTransition()

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFired = useRef(false)

  const lastDay    = new Date(cursor.year, cursor.month + 1, 0).getDate()
  const monthStart = toDateStr(cursor.year, cursor.month, 1)
  const monthEnd   = toDateStr(cursor.year, cursor.month, lastDay)

  const loadMonth = useCallback(async () => {
    setLoading(true)
    const rows = await getMyAvailability(monthStart, monthEnd)
    const map: Record<string, AvailabilityDay> = {}
    for (const row of rows) map[row.available_date] = row
    setDays(map)
    setLoading(false)
  }, [monthStart, monthEnd])

  useEffect(() => { loadMonth() }, [loadMonth])

  const goToMonth = (delta: number) => {
    setCursor((c) => {
      const total = c.year * 12 + c.month + delta
      return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 }
    })
  }

  // Default (no entry) → Available → Unavailable → Default
  const cycleDay = (dateStr: string) => {
    const current = days[dateStr]
    let nextAvailable: boolean | null
    if (!current) nextAvailable = true
    else if (current.is_available) nextAvailable = false
    else nextAvailable = null

    const nextNotes = nextAvailable === null ? null : (current?.notes ?? null)

    setDays((prev) => {
      const copy = { ...prev }
      if (nextAvailable === null) delete copy[dateStr]
      else copy[dateStr] = { available_date: dateStr, is_available: nextAvailable, notes: nextNotes }
      return copy
    })

    startSave(async () => { await setCrewAvailability(dateStr, nextAvailable, nextNotes) })
  }

  const openNotes = (dateStr: string) => {
    setNotesDate(dateStr)
    setNotesDraft(days[dateStr]?.notes ?? '')
  }

  const saveNotes = () => {
    if (!notesDate) return
    const isAvailable = days[notesDate]?.is_available ?? true
    const trimmed     = notesDraft.trim() || null

    setDays((prev) => ({
      ...prev,
      [notesDate]: { available_date: notesDate, is_available: isAvailable, notes: trimmed },
    }))
    startSave(async () => { await setCrewAvailability(notesDate, isAvailable, trimmed) })
    setNotesDate(null)
  }

  const handlePointerDown = (dateStr: string) => {
    longPressFired.current = false
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true
      openNotes(dateStr)
    }, LONG_PRESS_MS)
  }

  const handlePointerUp = (dateStr: string) => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    if (!longPressFired.current) cycleDay(dateStr)
  }

  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
  }

  const firstWeekday = new Date(cursor.year, cursor.month, 1).getDay()
  const cells: (number | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: lastDay }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  const monthLabel = new Date(cursor.year, cursor.month, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const todayStr = new Date().toISOString().split('T')[0]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-accent-900">My Availability</h2>
        <p className="text-sm text-accent-500 mt-0.5">Tap a day to mark it, tap again to flip. Hold to add a note.</p>
      </div>

      <div className="bg-white rounded-xl border border-accent-200 p-4">
        <div className="flex items-center justify-between mb-4">
          <button onClick={() => goToMonth(-1)} className="p-2 rounded-lg hover:bg-accent-50 text-accent-600" aria-label="Previous month">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <span className="font-semibold text-accent-900">{monthLabel}</span>
          <button onClick={() => goToMonth(1)} className="p-2 rounded-lg hover:bg-accent-50 text-accent-600" aria-label="Next month">
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 mb-1">
          {WEEKDAYS.map((d, i) => (
            <div key={i} className="text-center text-xs font-semibold text-accent-400 py-1">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => {
            if (day === null) return <div key={`empty-${i}`} />
            const dateStr = toDateStr(cursor.year, cursor.month, day)
            const entry   = days[dateStr]
            const isToday = dateStr === todayStr

            return (
              <button
                key={dateStr}
                type="button"
                onPointerDown={() => handlePointerDown(dateStr)}
                onPointerUp={() => handlePointerUp(dateStr)}
                onPointerLeave={cancelLongPress}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  'relative aspect-square rounded-lg flex items-center justify-center text-sm font-medium transition-colors select-none touch-manipulation',
                  !entry && 'bg-accent-50 text-accent-700 hover:bg-accent-100',
                  entry?.is_available === true  && 'bg-green-100 text-green-800 hover:bg-green-200',
                  entry?.is_available === false && 'bg-red-100 text-red-700 hover:bg-red-200',
                  isToday && 'ring-2 ring-brand-700',
                )}
              >
                {day}
                {entry?.notes && (
                  <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-brand-700" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-accent-500 flex-wrap">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-accent-50 border border-accent-200" />No preference</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-green-100" />Available</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-100" />Unavailable</span>
        <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-brand-700" />Has note</span>
      </div>

      {loading && <p className="text-xs text-accent-400 text-center">Loading…</p>}

      {notesDate && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-accent-900">
                Note for {new Date(`${notesDate}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </h3>
              <button onClick={() => setNotesDate(null)} className="p-1.5 rounded-lg hover:bg-accent-50 text-accent-500" aria-label="Close">
                <XIcon className="w-4 h-4" />
              </button>
            </div>
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              rows={3}
              placeholder="e.g. Out of town until 2pm"
              className="w-full rounded-lg border border-accent-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-700"
            />
            <div className="flex gap-2 mt-4">
              <button onClick={saveNotes} className="flex-1 bg-brand-800 text-white rounded-lg py-2 text-sm font-medium flex items-center justify-center gap-1.5">
                <Check className="w-4 h-4" />
                Save Note
              </button>
              <button onClick={() => setNotesDate(null)} className="px-4 rounded-lg border border-accent-200 text-accent-600 text-sm font-medium">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
