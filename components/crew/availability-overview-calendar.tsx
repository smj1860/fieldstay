'use client'

import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
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

export function AvailabilityOverviewCalendar({ crew, availabilityMap }: Props) {
  const now   = new Date()
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  // Only allow navigating between current month and next month
  // (matches the 2-month data window fetched server-side)
  const [viewDate, setViewDate] = useState<Date>(thisMonth)

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

  // Invert availabilityMap: date → array of unavailable CrewMember
  const dateToUnavailable = new Map<string, CrewMember[]>()
  for (const [crewId, entries] of Object.entries(availabilityMap)) {
    const member = crewById.get(crewId)
    if (!member) continue
    for (const entry of entries) {
      if (!entry.is_available) {
        if (!dateToUnavailable.has(entry.available_date)) {
          dateToUnavailable.set(entry.available_date, [])
        }
        dateToUnavailable.get(entry.available_date)!.push(member)
      }
    }
  }

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
          className="p-2 rounded-lg transition-colors disabled:opacity-30"
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
          className="p-2 rounded-lg transition-colors disabled:opacity-30"
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
        {cells.map((dayNum, idx) => {
          if (dayNum === null) {
            return (
              <div
                key={`empty-${idx}`}
                className="min-h-[80px]"
                style={{
                  background:  'var(--bg-raised)',
                  borderRight: '1px solid var(--border)',
                  borderBottom:'1px solid var(--border)',
                }}
              />
            )
          }

          const dateStr     = isoDate(dayNum)
          const unavailable = dateToUnavailable.get(dateStr) ?? []
          const isToday     = dateStr === todayStr
          const isPast      = dateStr < todayStr

          // Show up to 3 badges, then "+N more"
          const SHOW_MAX = 3
          const visible  = unavailable.slice(0, SHOW_MAX)
          const overflow = unavailable.length - SHOW_MAX

          return (
            <div
              key={dateStr}
              className="min-h-[80px] p-1.5 flex flex-col"
              style={{
                background:   isToday
                  ? 'rgba(252,209,22,0.07)'
                  : isPast
                  ? 'var(--bg-raised)'
                  : 'var(--bg-card)',
                borderRight:  '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                outline:      isToday ? '2px solid var(--accent-gold)' : 'none',
                outlineOffset: '-2px',
                opacity:      isPast && !isToday ? 0.55 : 1,
              }}
            >
              {/* Day number */}
              <span
                className="text-xs font-semibold mb-1"
                style={{
                  color: isToday
                    ? 'var(--accent-gold)'
                    : 'var(--text-secondary)',
                }}
              >
                {dayNum}
              </span>

              {/* Unavailable badges */}
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
                  <span
                    className="text-[10px] px-1"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    +{overflow} more
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      {activeCrew.length > 0 && (
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
          {activeCrew.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              No crew members have joined yet. Invite crew to track availability.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
