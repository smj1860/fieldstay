'use client'

import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import type { CrewMember, CrewAvailabilityEntry } from '@/types/database'

// Deterministic color palette — index-stable across renders
const CREW_COLORS = [
  '#60a5fa', // blue
  '#34d399', // emerald
  '#fbbf24', // amber
  '#a78bfa', // violet
  '#f472b6', // pink
  '#38bdf8', // sky
  '#fb923c', // orange
  '#4ade80', // green
] as const

interface Props {
  crew:            CrewMember[]
  availabilityMap: Record<string, CrewAvailabilityEntry[]>
}


/**
 * Inverts the per-crew availability map into two per-date maps: who is
 * unavailable (drives the grid badges) and every record for that date
 * (drives the day-detail modal).
 */
function invertAvailability(
  availabilityMap: Record<string, CrewAvailabilityEntry[]>,
  crewById:        Map<string, CrewMember>,
): {
  dateToUnavailable: Map<string, CrewMember[]>
  dateToRecords:     Map<string, { member: CrewMember; entry: CrewAvailabilityEntry }[]>
} {
  const dateToUnavailable = new Map<string, CrewMember[]>()
  const dateToRecords     = new Map<string, { member: CrewMember; entry: CrewAvailabilityEntry }[]>()

  const push = <T,>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }

  for (const [crewId, entries] of Object.entries(availabilityMap)) {
    const member = crewById.get(crewId)
    if (!member) continue

    for (const entry of entries) {
      if (!entry.is_available) push(dateToUnavailable, entry.available_date, member)
      push(dateToRecords, entry.available_date, { member, entry })
    }
  }

  return { dateToUnavailable, dateToRecords }
}

/** A leading blank cell before the first of the month. */
function EmptyCell() {
  return (
    <div
      className="min-h-[80px]"
      style={{
        background:  'var(--bg-raised)',
        borderRight: '1px solid var(--border)',
        borderBottom:'1px solid var(--border)',
      }}
    />
  )
}

/** Background and day-number colour depend on the same past/today/future
 *  classification, so it is decided once. */
function dayTone(isToday: boolean, isPast: boolean): { background: string; numberColor: string } {
  if (isToday) return { background: 'rgba(252,209,22,0.07)', numberColor: 'var(--accent-gold)' }
  if (isPast)  return { background: 'var(--bg-raised)',      numberColor: 'var(--text-muted)' }
  return { background: 'var(--bg-card)', numberColor: 'var(--text-secondary)' }
}

/** Show at most this many crew badges in a cell before collapsing to "+N more". */
const SHOW_MAX = 3

/** One day in the grid: its number and who is unavailable on it. */
function DayCell({
  dayNum, dateStr, todayStr, unavailable, crewColor, onSelect,
}: Readonly<{
  dayNum:      number
  dateStr:     string
  todayStr:    string
  unavailable: CrewMember[]
  crewColor:   Map<string, string>
  onSelect:    (dateStr: string) => void
}>) {
  const isToday = dateStr === todayStr
  const isPast  = dateStr < todayStr
  const tone    = dayTone(isToday, isPast)

  const visible  = unavailable.slice(0, SHOW_MAX)
  const overflow = unavailable.length - SHOW_MAX

  return (
    <button
      type="button"
      onClick={() => onSelect(dateStr)}
      className="min-h-[80px] p-1.5 flex flex-col text-left cursor-pointer transition-colors"
      style={{
        background:    tone.background,
        borderRight:   '1px solid var(--border)',
        borderBottom:  '1px solid var(--border)',
        outline:       isToday ? '2px solid var(--accent-gold)' : 'none',
        outlineOffset: '-2px',
      }}
    >
      <span className="text-xs font-semibold mb-1" style={{ color: tone.numberColor }}>
        {dayNum}
      </span>

      <div className="flex flex-col gap-0.5">
        {visible.map((member) => (
          <div
            key={member.id}
            className="flex items-center gap-1 px-1 py-0.5 rounded text-xs truncate"
            style={{
              background: `${crewColor.get(member.id)}20`,
              color:       crewColor.get(member.id),
            }}
            title={`${member.name} — unavailable`}
          >
            <span
              className="w-3.5 h-3.5 rounded-full flex-shrink-0 flex items-center
                         justify-center text-[9px] font-bold"
              style={{ background: crewColor.get(member.id), color: '#fff' }}
            >
              {member.name[0]?.toUpperCase()}
            </span>
            <span className="truncate font-medium">{member.name.split(' ')[0]}</span>
          </div>
        ))}
        {overflow > 0 && (
          <span className="text-[10px] px-1" style={{ color: 'var(--text-muted)' }}>
            +{overflow} more
          </span>
        )}
      </div>
    </button>
  )
}

/**
 * Colour key for the crew who have joined. Rendered only when there is at
 * least one, so the empty-state paragraph the previous version nested inside
 * that same guard was unreachable and is not carried forward.
 */
function CrewLegend({
  sortedCrew, crewColor,
}: Readonly<{ sortedCrew: CrewMember[]; crewColor: Map<string, string> }>) {
  return (
    <div className="mt-5">
      <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
        CREW LEGEND
      </p>
      <div className="flex flex-wrap gap-2">
        {sortedCrew.filter((c) => c.user_id).map((member) => (
          <div
            key={member.id}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs"
            style={{
              background: `${crewColor.get(member.id)}15`,
              color:       crewColor.get(member.id),
              border:      `1px solid ${crewColor.get(member.id)}30`,
            }}
          >
            <span
              className="w-4 h-4 rounded-full flex items-center justify-center
                         text-[9px] font-bold flex-shrink-0"
              style={{ background: crewColor.get(member.id), color: '#fff' }}
            >
              {member.name[0]?.toUpperCase()}
            </span>
            {member.name}
          </div>
        ))}
      </div>
    </div>
  )
}

export function AvailabilityOverviewCalendar({ crew, availabilityMap }: Readonly<Props>) {
  const now   = new Date()
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  // Only allow navigating between current month and next month
  // (matches the 2-month data window fetched server-side)
  const [viewDate, setViewDate] = useState<Date>(thisMonth)

  // Selected day for the detail modal — independent of viewDate so closing
  // the modal never resets the calendar's current month.
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const year       = viewDate.getFullYear()
  const month      = viewDate.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const firstDow    = new Date(year, month, 1).getDay()

  const isCurrentMonth = viewDate.getTime() === thisMonth.getTime()
  const isNextMonth    = viewDate.getTime() === nextMonth.getTime()

  // Assign colors to crew by sorted-name index (deterministic)
  const sortedCrew = [...crew].sort((a, b) => a.name.localeCompare(b.name))
  const crewColor  = new Map(sortedCrew.map((c, i) => [c.id, CREW_COLORS[i % CREW_COLORS.length]!]))
  const crewById   = new Map(crew.map((c) => [c.id, c]))

  const { dateToUnavailable, dateToRecords } = invertAvailability(availabilityMap, crewById)

  const todayStr = new Date().toISOString().split('T')[0]!

  // Calendar grid cells: null = empty leading cell
  const cells: (number | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  const isoDate = (dayNum: number): string =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`

  const monthLabel = viewDate.toLocaleDateString('en-US', {
    month: 'long',
    year:  'numeric',
  })

  const activeCrew = crew.filter((c) => c.user_id) // only invited+joined members

  return (
    <div>
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-5">
        <button
          onClick={() => setViewDate(thisMonth)}
          disabled={isCurrentMonth}
          className="min-h-11 min-w-11 flex items-center justify-center rounded-lg transition-colors disabled:opacity-30"
          style={{
            background: isCurrentMonth ? 'transparent' : 'var(--bg-raised)',
            color:      'var(--text-muted)',
          }}
          aria-label="Previous month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {monthLabel}
        </h2>

        <button
          onClick={() => setViewDate(nextMonth)}
          disabled={isNextMonth}
          className="min-h-11 min-w-11 flex items-center justify-center rounded-lg transition-colors disabled:opacity-30"
          style={{
            background: isNextMonth ? 'transparent' : 'var(--bg-raised)',
            color:      'var(--text-muted)',
          }}
          aria-label="Next month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div
            key={d}
            className="text-center text-xs font-medium py-1"
            style={{ color: 'var(--text-muted)' }}
          >
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div
        className="grid grid-cols-7 rounded-xl overflow-hidden"
        style={{ border: '1px solid var(--border)' }}
      >
        {cells.map((dayNum, idx) => dayNum === null
          ? <EmptyCell key={`empty-${idx}`} />
          : (
            <DayCell
              key={isoDate(dayNum)}
              dayNum={dayNum}
              dateStr={isoDate(dayNum)}
              todayStr={todayStr}
              unavailable={dateToUnavailable.get(isoDate(dayNum)) ?? []}
              crewColor={crewColor}
              onSelect={setSelectedDate}
            />
          ))}
      </div>

      {activeCrew.length > 0 && (
        <CrewLegend sortedCrew={sortedCrew} crewColor={crewColor} />
      )}

      {selectedDate && (
        <DayAvailabilityModal
          dateStr={selectedDate}
          records={dateToRecords.get(selectedDate) ?? []}
          crewColor={crewColor}
          onClose={() => setSelectedDate(null)}
        />
      )}
    </div>
  )
}

// ── Day detail modal ────────────────────────────────────────────────────────

function DayAvailabilityModal({
  dateStr,
  records,
  crewColor,
  onClose,
}: Readonly<{
  dateStr:   string
  records:   { member: CrewMember; entry: CrewAvailabilityEntry }[]
  crewColor: Map<string, string>
  onClose:   () => void
}>) {
  const dateLabel = new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month:   'long',
    day:     'numeric',
    year:    'numeric',
  })

  return (
    <Dialog open onClose={onClose} title={dateLabel} maxWidthClassName="max-w-sm">
      {records.length === 0 ? (
        <p className="text-sm text-muted-themed">
          No availability changes recorded for this day — all crew are assumed available.
        </p>
      ) : (
        <div className="space-y-2">
          {records.map(({ member, entry }) => (
            <div
              key={member.id}
              className="flex items-center gap-3 p-2 rounded-lg"
              style={{ background: 'var(--bg-raised)' }}
            >
              <span
                className="w-7 h-7 rounded-full flex-shrink-0 flex items-center
                           justify-center text-[11px] font-bold"
                style={{ background: crewColor.get(member.id), color: '#fff' }}
              >
                {member.name[0]?.toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-primary-themed truncate">
                  {member.name}
                </p>
                {entry.notes && (
                  <p className="text-xs text-muted-themed truncate">{entry.notes}</p>
                )}
              </div>
              <span
                className="text-xs font-semibold flex items-center gap-1.5 flex-shrink-0"
                style={{
                  color: entry.is_available ? 'var(--accent-green)' : 'var(--accent-red)',
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{
                    background: entry.is_available ? 'var(--accent-green)' : 'var(--accent-red)',
                  }}
                />
                {entry.is_available ? 'Available' : 'Unavailable'}
              </span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  )
}
