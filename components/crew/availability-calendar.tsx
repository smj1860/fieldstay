'use client'

import { useState, useTransition }  from 'react'
import { usePowerSyncQuery }         from '@powersync/react'
import { ChevronLeft, ChevronRight, CheckCircle2, XCircle } from 'lucide-react'
import { setCrewAvailability }       from '@/app/crew/availability/actions'

type AvailRow = { available_date: string; is_available: number }

interface Props {
  crewMemberId: string
  orgId:        string
}

export function AvailabilityCalendar({ crewMemberId, orgId: _orgId }: Props) {
  const [toggling, startToggle] = useTransition()
  const [toggleError, setToggleError] = useState<string | null>(null)

  // First day of the currently viewed month
  const [viewDate, setViewDate] = useState<Date>(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  // Compute month boundaries as YYYY-MM-DD strings
  const year       = viewDate.getFullYear()
  const month      = viewDate.getMonth()
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const lastDayNum = new Date(year, month + 1, 0).getDate()
  const monthEnd   = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`

  // Query this crew member's availability records for the viewed month
  const rows = usePowerSyncQuery<AvailRow>(
    `SELECT available_date, is_available
     FROM crew_availability
     WHERE crew_member_id = ?
       AND available_date >= ?
       AND available_date <= ?`,
    [crewMemberId, monthStart, monthEnd]
  )

  // Build lookup: 'YYYY-MM-DD' → 0 | 1
  const availMap = new Map<string, number>()
  for (const row of rows ?? []) {
    availMap.set(row.available_date, row.is_available)
  }

  // Calendar grid: null for leading empty cells, then day numbers
  const firstDow = new Date(year, month, 1).getDay() // 0=Sun
  const cells: (number | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...Array.from({ length: lastDayNum }, (_, i) => i + 1),
  ]

  // Today's date for highlighting, normalised to midnight
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const isoDate = (dayNum: number): string =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`

  const toggleDay = (dayNum: number) => {
    const dateStr        = isoDate(dayNum)
    const currentVal     = availMap.get(dateStr) ?? 1 // default = available
    const newIsAvailable = currentVal === 1 ? false : true

    setToggleError(null)
    startToggle(async () => {
      const result = await setCrewAvailability(dateStr, newIsAvailable)
      if (result.error) setToggleError(result.error)
    })
  }

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1))
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1))

  const monthLabel = viewDate.toLocaleDateString('en-US', {
    month: 'long',
    year:  'numeric',
  })

  return (
    <div>
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-5">
        <button
          onClick={prevMonth}
          className="p-2 rounded-xl bg-accent-50 text-accent-600 active:bg-accent-100
                     transition-colors"
          aria-label="Previous month"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h2 className="text-base font-semibold text-accent-900">{monthLabel}</h2>
        <button
          onClick={nextMonth}
          className="p-2 rounded-xl bg-accent-50 text-accent-600 active:bg-accent-100
                     transition-colors"
          aria-label="Next month"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-1">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
          <div
            key={d}
            className="text-center text-xs font-medium text-accent-400 py-1"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Calendar day grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((dayNum, idx) => {
          if (dayNum === null) {
            return <div key={`empty-${idx}`} />
          }

          const dateStr    = isoDate(dayNum)
          const isAvailVal = availMap.get(dateStr) ?? 1
          const isUnavail  = isAvailVal === 0
          const cellDate   = new Date(year, month, dayNum)
          const isToday    = cellDate.getTime() === today.getTime()
          const isPast     = cellDate < today

          return (
            <button
              key={dateStr}
              onClick={() => toggleDay(dayNum)}
              disabled={toggling}
              aria-label={`${dateStr}: ${isUnavail ? 'unavailable' : 'available'} — tap to toggle`}
              className="relative flex flex-col items-center justify-center py-2 rounded-xl
                         transition-all active:scale-95 disabled:opacity-60"
              style={{
                background: isUnavail
                  ? 'rgba(239,68,68,0.08)'
                  : isToday
                  ? 'rgba(252,209,22,0.15)'
                  : 'transparent',
                border: isToday
                  ? '2px solid #FCD116'
                  : '1px solid transparent',
                opacity: isPast && !isToday ? 0.45 : 1,
              }}
            >
              <span
                className={`text-sm font-semibold leading-none ${
                  isUnavail ? 'text-red-600'    :
                  isToday   ? 'text-accent-900' :
                              'text-accent-700'
                }`}
              >
                {dayNum}
              </span>
              <span className="mt-0.5">
                {isUnavail ? (
                  <XCircle className="w-3.5 h-3.5 text-red-500" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                )}
              </span>
            </button>
          )
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-8 mt-6">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <span className="text-xs text-accent-500">Available</span>
        </div>
        <div className="flex items-center gap-1.5">
          <XCircle className="w-4 h-4 text-red-500" />
          <span className="text-xs text-accent-500">Unavailable</span>
        </div>
      </div>

      <p className="text-xs text-accent-400 text-center mt-3">
        Tap any day to toggle your availability
      </p>

      {toggleError && (
        <p className="text-xs text-red-500 text-center mt-2">{toggleError}</p>
      )}
    </div>
  )
}
