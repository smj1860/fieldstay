'use client'

import { useMemo } from 'react'
import { cn } from '@/lib/utils'

interface BookingRow {
  id: string
  property_id: string
  checkin_date: string
  checkout_date: string
  guest_name: string | null
  status: string
}

interface Turnover {
  id: string
  property_id: string
  checkout_datetime: string
  checkin_datetime: string
  window_minutes: number | null
  status: string
}

interface Property {
  id: string
  name: string
}

function dayOffset(date: Date, today: Date): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return Math.floor((d.getTime() - today.getTime()) / 86_400_000)
}

export function TurnoverGantt({
  turnovers,
  bookings,
  properties,
  windowDays = 14,
}: {
  turnovers:  Turnover[]
  bookings:   BookingRow[]
  properties: Property[]
  windowDays?: number
}) {
  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  const days = useMemo(() =>
    Array.from({ length: windowDays }, (_, i) => {
      const d = new Date(today)
      d.setDate(d.getDate() + i)
      return d
    }),
  [today, windowDays])

  const propData = useMemo(() => {
    const map: Record<string, { bookings: BookingRow[]; turnovers: Turnover[] }> = {}
    for (const p of properties) map[p.id] = { bookings: [], turnovers: [] }
    for (const b of bookings)   map[b.property_id]?.bookings.push(b)
    for (const t of turnovers)  map[t.property_id]?.turnovers.push(t)
    return map
  }, [properties, bookings, turnovers])

  const COL_PX    = 52
  const LABEL_W   = 160
  const totalWidth = days.length * COL_PX + LABEL_W

  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0 rounded-xl border border-themed">
      <div style={{ minWidth: totalWidth }}>

        {/* Header */}
        <div className="flex sticky top-0 z-10 border-b border-themed"
             style={{ background: 'var(--bg-card)' }}>
          <div className="flex-shrink-0 border-r border-themed"
               style={{ width: LABEL_W, padding: '8px 12px', fontSize: 10 }} />
          {days.map(d => {
            const isToday = d.toDateString() === new Date().toDateString()
            return (
              <div
                key={d.toISOString()}
                className={cn('flex-shrink-0 text-center border-r border-themed py-2')}
                style={{
                  width:      COL_PX,
                  background: isToday ? 'var(--accent-gold-dim)' : undefined,
                  color:      isToday ? 'var(--accent-gold)' : 'var(--text-muted)',
                  fontSize:   10,
                  fontWeight: isToday ? 700 : 400,
                }}
              >
                <div>{d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                <div>{d.getDate()}</div>
              </div>
            )
          })}
        </div>

        {/* Rows */}
        {properties.map(prop => {
          const data = propData[prop.id] ?? { bookings: [], turnovers: [] }

          return (
            <div key={prop.id} className="flex border-b border-themed" style={{ height: 60 }}>
              {/* Label */}
              <div
                className="flex-shrink-0 flex items-center px-3 border-r border-themed"
                style={{ width: LABEL_W, background: 'var(--bg-card)' }}
              >
                <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {prop.name}
                </span>
              </div>

              {/* Timeline */}
              <div className="relative flex-1" style={{ background: 'var(--bg-canvas)' }}>
                {days.map((d, idx) => (
                  <div
                    key={d.toISOString()}
                    className="absolute inset-y-0 border-r border-themed"
                    style={{
                      left:       idx * COL_PX,
                      width:      COL_PX,
                      background: d.toDateString() === new Date().toDateString()
                        ? 'var(--accent-gold-dim)'
                        : undefined,
                    }}
                  />
                ))}

                {/* Booking blocks (blue) */}
                {data.bookings.map(b => {
                  const start = Math.max(0, dayOffset(new Date(b.checkin_date + 'T00:00:00'), today))
                  const end   = Math.min(days.length, dayOffset(new Date(b.checkout_date + 'T00:00:00'), today))
                  if (end <= 0 || start >= days.length || end <= start) return null
                  return (
                    <div
                      key={b.id}
                      className="absolute flex items-center px-1.5 overflow-hidden rounded"
                      title={b.guest_name ?? 'Booking'}
                      style={{
                        left:       start * COL_PX + 2,
                        width:      Math.max(4, (end - start) * COL_PX - 4),
                        top:        4, height: 22,
                        background: 'var(--accent-blue-dim)',
                        border:     '1px solid rgba(59,130,246,0.4)',
                        fontSize:   9, color: 'var(--accent-blue)', fontWeight: 600, zIndex: 2,
                      }}
                    >
                      <span className="truncate">{b.guest_name ?? 'Guest'}</span>
                    </div>
                  )
                })}

                {/* Cleaning window blocks */}
                {data.turnovers.map(t => {
                  if (t.status === 'cancelled') return null
                  const checkoutDay = new Date(t.checkout_datetime)
                  const start = dayOffset(checkoutDay, today)
                  const isTight = (t.window_minutes ?? 0) < 120
                  if (start < 0 || start >= days.length) return null
                  return (
                    <div
                      key={t.id}
                      className="absolute overflow-hidden rounded flex items-center"
                      title={`${Math.floor((t.window_minutes ?? 0) / 60)}h window`}
                      style={{
                        left:       start * COL_PX + 2,
                        width:      COL_PX - 4,
                        top:        30, height: 22,
                        background: isTight ? 'var(--accent-red-dim)'   : 'var(--accent-gold-dim)',
                        border:     isTight ? '1px solid var(--accent-red)' : '1px solid rgba(252,209,22,0.4)',
                        fontSize:   9,
                        color:      isTight ? 'var(--accent-red)' : 'var(--accent-gold)',
                        fontWeight: 600, paddingLeft: 4, zIndex: 2,
                      }}
                    >
                      {isTight ? '⚠ Tight' : '🧹 Clean'}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 px-4 py-3 flex-wrap border-t border-themed"
           style={{ background: 'var(--bg-card)' }}>
        {[
          { bg: 'var(--accent-blue-dim)',  border: 'rgba(59,130,246,0.4)', color: 'var(--accent-blue)',  label: 'Booking'             },
          { bg: 'var(--accent-gold-dim)',  border: 'rgba(252,209,22,0.4)', color: 'var(--accent-gold)',  label: 'Cleaning window'     },
          { bg: 'var(--accent-red-dim)',   border: 'var(--accent-red)',     color: 'var(--accent-red)',   label: 'Tight (< 2h)'        },
        ].map(item => (
          <div key={item.label} className="flex items-center gap-1.5 text-xs"
               style={{ color: 'var(--text-muted)' }}>
            <div className="w-4 h-3 rounded-sm flex-shrink-0"
                 style={{ background: item.bg, border: `1px solid ${item.border}` }} />
            {item.label}
          </div>
        ))}
      </div>
    </div>
  )
}
