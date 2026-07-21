'use client'

import { useMemo, useSyncExternalStore } from 'react'
import Link                             from 'next/link'
import { AlertTriangle, Sparkle }       from 'lucide-react'

// ── Types (match what TurnoverBoard already receives) ─────────────────────

interface Turnover {
  id:                string
  property_id:       string
  checkout_datetime: string
  checkin_datetime:  string
  window_minutes:    number | null
  status:            string
  priority:          string
}

interface Property {
  id:    string
  name:  string
  city?: string | null
  state?: string | null
}

interface Booking {
  id:            string
  property_id:   string
  checkin_date:  string
  checkout_date: string
  guest_name:    string | null
  status:        string
}

interface Props {
  turnovers:  Turnover[]
  properties: Property[]
  bookings:   Booking[]
}

// ── Constants ──────────────────────────────────────────────────────────────
// Sizing is viewport-dependent (see useIsMobile below) — mobile gets a
// narrower day range and smaller cells so the chart fits without forcing
// the whole card into horizontal scroll on small phones.

const DAYS_BACK = 3 // days of history to show, both viewports

// blockH + 2*cellPad must stay <= rowH or the booking and turnover blocks
// (one anchored top, one anchored bottom) will visually overlap.
const DESKTOP_SIZING = { daysAhead: 18, colW: 52, rowH: 72, labelW: 164, blockH: 28, cellPad: 8 }
const MOBILE_SIZING  = { daysAhead: 7,  colW: 36, rowH: 56, labelW: 100, blockH: 20, cellPad: 4 }

const MOBILE_BREAKPOINT = 640 // matches the `sm` breakpoint used elsewhere in the app

function subscribeToMobileBreakpoint(onChange: () => void): () => void {
  const mql = globalThis.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getIsMobileSnapshot(): boolean {
  return globalThis.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches
}

function useIsMobile(): boolean {
  return useSyncExternalStore(subscribeToMobileBreakpoint, getIsMobileSnapshot, () => false)
}

// ── Helpers ────────────────────────────────────────────────────────────────

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

function dayIndex(date: Date, windowStart: Date): number {
  return Math.round((date.getTime() - windowStart.getTime()) / 86_400_000)
}

// ── Turnover status → color ────────────────────────────────────────────────

function turnoverColors(status: string, isTight: boolean) {
  if (isTight) return { bg: 'var(--accent-red-dim)', fg: 'var(--accent-red)',    border: 'var(--accent-red)' }

  const map: Record<string, { bg: string; fg: string; border: string }> = {
    completed:          { bg: 'var(--accent-green-dim)',  fg: 'var(--accent-green)',  border: 'var(--accent-green)'  },
    in_progress:        { bg: 'var(--accent-purple-dim)', fg: 'var(--accent-purple)', border: 'var(--accent-purple)' },
    assigned:           { bg: 'var(--accent-blue-dim)',   fg: 'var(--accent-blue)',   border: 'var(--accent-blue)'   },
    pending_assignment: { bg: 'var(--accent-amber-dim)',  fg: 'var(--accent-amber)',  border: 'var(--accent-amber)'  },
    flagged:            { bg: 'var(--accent-red-dim)',    fg: 'var(--accent-red)',    border: 'var(--accent-red)'    },
  }
  return map[status] ?? { bg: 'var(--bg-raised)', fg: 'var(--text-muted)', border: 'var(--border)' }
}

// ── Component ──────────────────────────────────────────────────────────────

export function TurnoverGantt({ turnovers, properties, bookings }: Props) {
  const isMobile = useIsMobile()
  const { daysAhead, colW: COL_W, rowH: ROW_H, labelW: LABEL_W, blockH: BLOCK_H, cellPad: CELL_PAD } =
    isMobile ? MOBILE_SIZING : DESKTOP_SIZING
  const TOTAL_DAYS = DAYS_BACK + 1 + daysAhead

  const today      = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d }, [])
  const todayStr   = localDateStr(today)

  const windowStart = useMemo(() => {
    const d = new Date(today)
    d.setDate(d.getDate() - DAYS_BACK)
    return d
  }, [today])

  // Generate day column headers
  const days = useMemo(
    () => Array.from({ length: TOTAL_DAYS }, (_, i) => {
      const d = new Date(windowStart)
      d.setDate(d.getDate() + i)
      return d
    }),
    [windowStart, TOTAL_DAYS]
  )

  // Index data by property
  const bookingsByProp  = useMemo(() => {
    const m = new Map<string, Booking[]>()
    for (const b of bookings) {
      if (!m.has(b.property_id)) m.set(b.property_id, [])
      m.get(b.property_id)!.push(b)
    }
    return m
  }, [bookings])

  const turnoversByProp = useMemo(() => {
    const m = new Map<string, Turnover[]>()
    for (const t of turnovers) {
      if (!m.has(t.property_id)) m.set(t.property_id, [])
      m.get(t.property_id)!.push(t)
    }
    return m
  }, [turnovers])

  // Only show properties that have activity in the window, sorted by name
  const activeProperties = useMemo(
    () => properties.filter(
      (p) => bookingsByProp.has(p.id) || turnoversByProp.has(p.id)
    ).sort((a, b) => a.name.localeCompare(b.name)),
    [properties, bookingsByProp, turnoversByProp]
  )

  const totalW = TOTAL_DAYS * COL_W

  return (
    <div
      className="rounded-xl overflow-hidden flex flex-col min-h-[420px] h-[calc(100vh-280px)]"
      style={{ border: '1px solid var(--border)' }}
    >
      {/* Scroll container — flex-1 so a short property list still fills the
          card instead of leaving a gap of bare page background beneath it */}
      <div className="overflow-x-auto flex-1">
        <div style={{ minWidth: LABEL_W + totalW }}>

          {/* ── Header row ── */}
          <div
            className="flex sticky top-0 z-20"
            style={{ background: 'var(--bg-raised)', borderBottom: '1px solid var(--border)' }}
          >
            {/* Property label column header */}
            <div
              className="flex-shrink-0 sticky left-0 z-30 flex items-center px-3 py-2"
              style={{
                width:       LABEL_W,
                background:  'var(--bg-raised)',
                borderRight: '1px solid var(--border)',
              }}
            >
              <span className="text-xs font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)' }}>
                Property
              </span>
            </div>

            {/* Day column headers */}
            {days.map((day, i) => {
              const isToday = localDateStr(day) === todayStr
              const isPast  = day < today
              return (
                <div
                  key={i}
                  className="flex-shrink-0 flex flex-col items-center justify-center py-2"
                  style={{
                    width:       COL_W,
                    borderRight: '1px solid var(--border)',
                    background:  isToday ? 'rgba(252,209,22,0.08)' : 'transparent',
                    borderBottom: isToday ? '2px solid var(--accent-gold)' : '1px solid var(--border)',
                    opacity:     isPast && !isToday ? 0.5 : 1,
                  }}
                >
                  <span
                    className="text-[10px] font-medium"
                    style={{ color: isToday ? 'var(--accent-gold)' : 'var(--text-muted)' }}
                  >
                    {day.toLocaleDateString('en-US', { weekday: 'short' })}
                  </span>
                  <span
                    className="text-xs font-bold"
                    style={{ color: isToday ? 'var(--accent-gold)' : 'var(--text-secondary)' }}
                  >
                    {day.getDate()}
                  </span>
                </div>
              )
            })}
          </div>

          {/* ── Property rows ── */}
          {activeProperties.length === 0 ? (
            <div
              className="flex items-center justify-center py-16 text-sm"
              style={{ color: 'var(--text-muted)' }}
            >
              No properties with bookings or turnovers in this window.
            </div>
          ) : (
            activeProperties.map((property, rowIdx) => {
              const propBookings  = bookingsByProp.get(property.id)  ?? []
              const propTurnovers = turnoversByProp.get(property.id) ?? []

              return (
                <div
                  key={property.id}
                  className="flex relative"
                  style={{
                    height:      ROW_H,
                    borderBottom:'1px solid var(--border)',
                    background:  rowIdx % 2 === 0 ? 'var(--bg-card)' : 'var(--bg-raised)',
                  }}
                >
                  {/* Property label — sticky left */}
                  <div
                    className="flex-shrink-0 sticky left-0 z-10 flex flex-col
                               justify-center px-3 py-2"
                    style={{
                      width:       LABEL_W,
                      background:  rowIdx % 2 === 0 ? 'var(--bg-card)' : 'var(--bg-raised)',
                      borderRight: '1px solid var(--border)',
                    }}
                  >
                    <span
                      className="text-xs font-semibold truncate leading-tight"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {property.name}
                    </span>
                    {(property.city || property.state) && (
                      <span
                        className="text-[10px] truncate mt-0.5"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {[property.city, property.state].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </div>

                  {/* Timeline cells — one per day */}
                  <div className="flex relative flex-1">
                    {days.map((day, colIdx) => {
                      const isToday = localDateStr(day) === todayStr
                      const isPast  = day < today
                      return (
                        <div
                          key={colIdx}
                          className="flex-shrink-0 relative"
                          style={{
                            width:       COL_W,
                            height:      ROW_H,
                            borderRight: '1px solid var(--border)',
                            background:  isToday
                              ? 'rgba(252,209,22,0.05)'
                              : isPast
                              ? 'rgba(0,0,0,0.04)'
                              : 'transparent',
                          }}
                        />
                      )
                    })}

                    {/* ── Booking blocks ── */}
                    {propBookings.map((booking) => {
                      const checkinDay  = parseLocalDate(booking.checkin_date)
                      const checkoutDay = parseLocalDate(booking.checkout_date)

                      const startIdx = Math.max(0, dayIndex(checkinDay, windowStart))
                      const endIdx   = Math.min(TOTAL_DAYS - 1, dayIndex(checkoutDay, windowStart) - 1)

                      if (startIdx > endIdx || endIdx < 0 || startIdx >= TOTAL_DAYS) return null

                      const leftPx  = startIdx * COL_W
                      const widthPx = (endIdx - startIdx + 1) * COL_W - 2

                      return (
                        <div
                          key={booking.id}
                          className="absolute rounded-md px-2 flex items-center
                                     text-[10px] font-medium truncate"
                          style={{
                            left:       leftPx + 1,
                            width:      widthPx,
                            top:        CELL_PAD,
                            height:     BLOCK_H,
                            background: 'var(--accent-blue-dim)',
                            color:      'var(--accent-blue)',
                            border:     '1px solid var(--accent-blue)',
                            opacity:    parseLocalDate(booking.checkout_date) < today ? 0.45 : 1,
                          }}
                          title={`${booking.guest_name ?? 'Guest'} · ${booking.checkin_date} – ${booking.checkout_date}`}
                        >
                          {booking.guest_name ?? 'Booking'}
                        </div>
                      )
                    })}

                    {/* ── Turnover indicators ── */}
                    {propTurnovers.map((turnover) => {
                      const checkoutDT = new Date(turnover.checkout_datetime)
                      const checkoutDay = new Date(
                        checkoutDT.getFullYear(), checkoutDT.getMonth(), checkoutDT.getDate()
                      )
                      const colIdx = dayIndex(checkoutDay, windowStart)

                      if (colIdx < 0 || colIdx >= TOTAL_DAYS) return null

                      // Tight window detection
                      const windowMinutes = turnover.window_minutes ?? 0
                      const windowMs  = windowMinutes * 60_000
                      const checkinDT = new Date(turnover.checkin_datetime)
                      const gapMs     = checkinDT.getTime() - checkoutDT.getTime()
                      const isTight   = gapMs > 0 && gapMs < windowMs

                      const colors = turnoverColors(turnover.status, isTight)
                      const leftPx = colIdx * COL_W + 2

                      return (
                        <Link
                          key={turnover.id}
                          href={`/turnovers/${turnover.id}`}
                          className="absolute rounded flex items-center
                                     justify-center text-[10px] font-semibold
                                     transition-opacity hover:opacity-80 truncate px-1.5"
                          style={{
                            left:       leftPx,
                            width:      COL_W - 4,
                            bottom:     CELL_PAD,
                            height:     BLOCK_H,
                            background: colors.bg,
                            color:      colors.fg,
                            border:     `1px solid ${colors.border}`,
                          }}
                          title={`${isTight ? 'Tight window — ' : ''}${turnover.status} · ${Math.round(windowMinutes / 60 * 10) / 10}h window`}
                        >
                          {isTight ? <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0" /> : <Sparkle className="w-2.5 h-2.5 flex-shrink-0" />} {Math.round(windowMinutes / 60 * 10) / 10}h
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* ── Legend ── */}
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-3 text-xs"
        style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="w-4 h-2.5 rounded-sm inline-block"
            style={{ background: 'var(--accent-blue-dim)', border: '1px solid var(--accent-blue)' }}
          />
          Guest stay
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="w-4 h-2.5 rounded-sm inline-block"
            style={{ background: 'var(--accent-amber-dim)', border: '1px solid var(--accent-amber)' }}
          />
          Unassigned turnover
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="w-4 h-2.5 rounded-sm inline-block"
            style={{ background: 'var(--accent-blue-dim)', border: '1px solid var(--accent-blue)' }}
          />
          Assigned
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="w-4 h-2.5 rounded-sm inline-block"
            style={{ background: 'var(--accent-green-dim)', border: '1px solid var(--accent-green)' }}
          />
          Completed
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="w-4 h-2.5 rounded-sm inline-block"
            style={{ background: 'var(--accent-red-dim)', border: '1px solid var(--accent-red)' }}
          />
          Tight window
        </div>
      </div>
    </div>
  )
}
