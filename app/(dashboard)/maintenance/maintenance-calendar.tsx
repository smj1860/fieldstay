'use client'

import { useState } from 'react'
import { ChevronLeft, ChevronRight, ClipboardList } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

interface CalendarWO {
  id: string
  title: string
  property_id: string
  scheduled_date: string | null
  priority: string
  status: string
}

interface CalendarSchedule {
  id: string
  name: string
  property_id: string
  next_due_date: string | null
  properties: { name: string } | { name: string }[] | null
}

export function MaintenanceCalendar({
  workOrders,
  schedules,
}: Readonly<{
  workOrders: CalendarWO[]
  schedules:  CalendarSchedule[]
}>) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [calView, setCalView] = useState<'month' | 'week'>('month')
  const [month, setMonth]     = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date(today)
    d.setDate(d.getDate() - d.getDay())
    return d
  })

  const isoOf = (d: Date) => d.toISOString().split('T')[0]!

  // Month grid data
  const firstDay    = month.getDay()
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: (Date | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      new Date(month.getFullYear(), month.getMonth(), i + 1)
    ),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <div className="mb-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {calView === 'month' ? (
          <>
            <Button
              variant="ghost"
              onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              className="p-1.5"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </h3>
            <Button
              variant="ghost"
              onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              className="p-1.5"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button
              variant="secondary"
              onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}
              className="text-xs py-1"
            >
              Today
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setWeekStart(d => {
              const n = new Date(d); n.setDate(n.getDate() - 7); return n
            })} className="p-1.5">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              {' – '}
              {new Date(weekStart.getTime() + 6 * 86_400_000)
                .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
            <Button variant="ghost" onClick={() => setWeekStart(d => {
              const n = new Date(d); n.setDate(n.getDate() + 7); return n
            })} className="p-1.5">
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const d = new Date(today)
                d.setDate(d.getDate() - d.getDay())
                setWeekStart(d)
              }}
              className="text-xs py-1"
            >
              This Week
            </Button>
          </>
        )}

        {/* View toggle — pinned to the right */}
        <div className="flex items-center gap-1 border border-themed rounded-lg px-1 py-1 ml-auto"
             style={{ background: 'var(--bg-card)' }}>
          {(['month', 'week'] as const).map(v => (
            <button
              key={v}
              onClick={() => setCalView(v)}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-md transition-colors capitalize',
                calView !== v && 'text-muted-themed hover:text-secondary-themed'
              )}
              style={calView === v ? { background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' } : undefined}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* ── Month view ── */}
      {calView === 'month' && (
        <>
          {workOrders.length === 0 && schedules.length === 0 && (
            <div className="text-center py-10 text-sm border border-themed rounded-xl mb-4"
                 style={{ color: 'var(--text-muted)', background: 'var(--bg-card)' }}>
              No items scheduled — add a date to a work order or maintenance schedule to see it here.
            </div>
          )}
          <div className="grid grid-cols-7 mb-1">
            {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
              <div key={d} className="text-center text-xs font-semibold py-1"
                   style={{ color: 'var(--text-muted)' }}>
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-px rounded-xl overflow-hidden"
               style={{ background: 'var(--border)' }}>
            {cells.map((day, idx) => {
              if (!day) {
                return (
                  <div key={idx} style={{ background: 'var(--bg-canvas)', minHeight: 80 }} />
                )
              }

              const iso       = isoOf(day)
              const isToday   = day.toDateString() === today.toDateString()
              const isPast    = day < today
              const dayWOs    = workOrders.filter(wo => wo.scheduled_date === iso)
              const dayScheds = schedules.filter(s  => s.next_due_date  === iso)
              const total     = dayWOs.length + dayScheds.length

              return (
                <div
                  key={iso}
                  className="p-1.5"
                  style={{
                    background:   isToday ? 'var(--bg-raised)' : 'var(--bg-card)',
                    minHeight:    80,
                    outline:      isToday ? '2px solid var(--accent-gold)' : undefined,
                    outlineOffset: -2,
                  }}
                >
                  <div className="text-xs font-semibold mb-1">
                    <span style={{
                      color: isToday ? 'var(--accent-gold)'
                           : isPast  ? 'var(--text-muted)'
                                     : 'var(--text-primary)',
                    }}>
                      {day.getDate()}
                    </span>
                  </div>

                  {dayWOs.slice(0, 3).map(wo => {
                    const isOverdue = isPast && wo.status !== 'completed'
                    const isUrgent  = wo.priority === 'urgent' || wo.priority === 'high'
                    return (
                      <div
                        key={wo.id}
                        className="text-xs px-1 py-0.5 rounded mb-0.5 truncate"
                        style={{
                          background: isOverdue ? 'var(--accent-red-dim)'
                                    : isUrgent  ? 'var(--accent-amber-dim)'
                                                : 'var(--accent-blue-dim)',
                          color:      isOverdue ? 'var(--accent-red)'
                                    : isUrgent  ? 'var(--accent-amber)'
                                                : 'var(--accent-blue)',
                          border:     isOverdue ? '1px solid var(--accent-red)' : undefined,
                          fontSize:   10,
                        }}
                        title={wo.title}
                      >
                        {wo.title}
                      </div>
                    )
                  })}

                  {dayScheds.slice(0, 2).map(s => (
                    <div
                      key={s.id}
                      className="text-xs px-1 py-0.5 rounded mb-0.5 truncate"
                      style={{
                        background: 'var(--accent-gold-dim)',
                        color:      'var(--accent-gold)',
                        fontSize:   10,
                      }}
                      title={s.name}
                    >
                      <ClipboardList className="inline w-2.5 h-2.5 mr-0.5" style={{ verticalAlign: '-1px' }} />{s.name}
                    </div>
                  ))}

                  {total > 3 && (
                    <div className="text-xs" style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                      +{total - 3} more
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── Week view ── */}
      {calView === 'week' && (
        <>
          {workOrders.length === 0 && schedules.length === 0 && (
            <div className="text-center py-10 text-sm border border-themed rounded-xl mb-4"
                 style={{ color: 'var(--text-muted)', background: 'var(--bg-card)' }}>
              No items scheduled — add a date to a work order or maintenance schedule to see it here.
            </div>
          )}
          <div className="grid grid-cols-7 gap-px" style={{ background: 'var(--border)' }}>
            {Array.from({ length: 7 }, (_, i) => {
              const day       = new Date(weekStart.getTime() + i * 86_400_000)
              const iso       = isoOf(day)
              const isToday   = day.toDateString() === today.toDateString()
              const dayWOs    = workOrders.filter(wo => wo.scheduled_date === iso)
              const dayScheds = schedules.filter(s => s.next_due_date === iso)

              return (
                <div
                  key={iso}
                  className="p-2"
                  style={{
                    background: isToday ? 'var(--bg-raised)' : 'var(--bg-card)',
                    minHeight:  180,
                    outline:    isToday ? '2px solid var(--accent-gold)' : undefined,
                    outlineOffset: -2,
                  }}
                >
                  <div className="text-xs font-semibold mb-1.5">
                    <span style={{ color: isToday ? 'var(--accent-gold)' : 'var(--text-secondary)' }}>
                      {day.toLocaleDateString('en-US', { weekday: 'short' })}
                    </span>
                    <span className="ml-1" style={{ color: isToday ? 'var(--accent-gold)' : 'var(--text-muted)' }}>
                      {day.getDate()}
                    </span>
                  </div>

                  {dayWOs.map(wo => {
                    const isOverdue = day < today && wo.status !== 'completed'
                    const isUrgent  = wo.priority === 'urgent' || wo.priority === 'high'
                    return (
                      <div
                        key={wo.id}
                        className="text-xs px-1.5 py-1 rounded mb-1 truncate"
                        style={{
                          background: isOverdue ? 'var(--accent-red-dim)'
                                    : isUrgent  ? 'var(--accent-amber-dim)'
                                                : 'var(--accent-blue-dim)',
                          color:      isOverdue ? 'var(--accent-red)'
                                    : isUrgent  ? 'var(--accent-amber)'
                                                : 'var(--accent-blue)',
                        }}
                        title={wo.title}
                      >
                        {wo.title}
                      </div>
                    )
                  })}

                  {dayScheds.map(s => (
                    <div
                      key={s.id}
                      className="text-xs px-1.5 py-1 rounded mb-1 truncate"
                      style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }}
                      title={s.name}
                    >
                      <ClipboardList className="inline w-2.5 h-2.5 mr-0.5" style={{ verticalAlign: '-1px' }} />{s.name}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        {[
          { bg: 'var(--accent-blue-dim)',  color: 'var(--accent-blue)',  label: 'Scheduled WO'  },
          { bg: 'var(--accent-gold-dim)',  color: 'var(--accent-gold)',  label: 'Schedule Due'  },
          { bg: 'var(--accent-amber-dim)', color: 'var(--accent-amber)', label: 'High Priority' },
          { bg: 'var(--accent-red-dim)',   color: 'var(--accent-red)',   label: 'Overdue'       },
        ].map(item => (
          <div key={item.label} className="flex items-center gap-1.5 text-xs"
               style={{ color: 'var(--text-muted)' }}>
            <div className="w-3 h-3 rounded-sm"
                 style={{ background: item.bg, border: `1px solid ${item.color}` }} />
            {item.label}
          </div>
        ))}
      </div>
    </div>
  )
}
