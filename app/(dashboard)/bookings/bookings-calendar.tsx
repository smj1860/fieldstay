'use client'

import { useCallback, useMemo, useState } from 'react'
import Timeline, { TimelineMarkers, TodayMarker } from 'react-calendar-timeline'
import dayjs from 'dayjs'
import { X, ExternalLink } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import type { BookingSource, BookingStatus } from '@/types/database'
import 'react-calendar-timeline/style.css'
import './bookings-calendar.css'

// ── Types ────────────────────────────────────────────────────────────────────
// Deliberately a subset of bookings-client.tsx's BookingRow — only the fields
// the grid and detail panel actually use.

interface BookingRow {
  id:            string
  property_id:   string
  guest_name:    string | null
  checkin_date:  string
  checkout_date: string
  checkin_time:  string | null
  checkout_time: string | null
  status:        BookingStatus
  source:        BookingSource
  notes:         string | null
  properties:    { id: string; name: string; city: string | null; state: string | null } | null
}

interface PropertyOption { id: string; name: string }

// ── Source / status styling ──────────────────────────────────────────────────
// Mirrors bookings-client.tsx's SOURCE_COLORS grouping (airbnb→red,
// vrbo/booking_com→blue, direct→green, manual→gold, other→muted) but as
// CSS-variable-driven {bg,fg,border} triples so the same booking reads as
// the same color in both List and Calendar views, and respects light/dark theme.

const SOURCE_LABELS: Record<BookingSource, string> = {
  airbnb:      'Airbnb',
  vrbo:        'VRBO',
  booking_com: 'Booking.com',
  direct:      'Direct',
  manual:      'Manual',
  other:       'Other',
}

const SOURCE_STYLE: Record<BookingSource, { bg: string; fg: string; border: string }> = {
  airbnb:      { bg: 'var(--accent-red-dim)',   fg: 'var(--accent-red)',   border: 'var(--accent-red)'   },
  vrbo:        { bg: 'var(--accent-blue-dim)',  fg: 'var(--accent-blue)',  border: 'var(--accent-blue)'  },
  booking_com: { bg: 'var(--accent-blue-dim)',  fg: 'var(--accent-blue)',  border: 'var(--accent-blue)'  },
  direct:      { bg: 'var(--accent-green-dim)', fg: 'var(--accent-green)', border: 'var(--accent-green)' },
  manual:      { bg: 'var(--accent-gold-dim)',  fg: 'var(--accent-gold)',  border: 'var(--accent-gold)'  },
  other:       { bg: 'var(--bg-raised)',        fg: 'var(--text-muted)',  border: 'var(--border)'       },
}

const STATUS_OPACITY: Record<BookingStatus, number> = {
  confirmed: 1,
  tentative: 0.65,
  blocked:   0.45,
  cancelled: 0.3,
}

const STATUS_BADGE_STYLE: Record<BookingStatus, React.CSSProperties> = {
  confirmed: { color: 'var(--accent-green)', background: 'var(--accent-green-dim)' },
  tentative: { color: 'var(--accent-amber)', background: 'var(--accent-amber-dim)' },
  blocked:   { color: 'var(--text-muted)',   background: 'var(--bg-raised)' },
  cancelled: { color: 'var(--accent-red)',   background: 'var(--accent-red-dim)' },
}

function bookingTitle(b: BookingRow): string {
  return b.status === 'blocked' ? 'Blocked' : (b.guest_name ?? 'Guest')
}

// ── Detail panel ─────────────────────────────────────────────────────────────

function BookingDetailPanel({
  booking,
  onClose,
  onViewInList,
}: {
  booking:      BookingRow
  onClose:      () => void
  onViewInList: (guestName: string) => void
}) {
  const nights = Math.round(
    (new Date(booking.checkout_date).getTime() - new Date(booking.checkin_date).getTime()) / 86_400_000
  )
  const sourceStyle = SOURCE_STYLE[booking.source] ?? SOURCE_STYLE.other

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      onClick={onClose}
    >
      <div
        className="rounded-2xl w-full max-w-md p-6"
        style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            {bookingTitle(booking)}
          </h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ background: sourceStyle.bg, color: sourceStyle.fg, border: `1px solid ${sourceStyle.border}` }}
          >
            {SOURCE_LABELS[booking.source]}
          </span>
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full capitalize"
            style={STATUS_BADGE_STYLE[booking.status]}
          >
            {booking.status}
          </span>
        </div>

        <div className="space-y-2.5 text-sm">
          <DetailRow label="Property"  value={booking.properties?.name ?? '—'} />
          <DetailRow
            label="Check-in"
            value={`${formatDate(booking.checkin_date)}${booking.checkin_time ? ` at ${booking.checkin_time}` : ''}`}
          />
          <DetailRow
            label="Check-out"
            value={`${formatDate(booking.checkout_date)}${booking.checkout_time ? ` at ${booking.checkout_time}` : ''}`}
          />
          <DetailRow label="Nights" value={`${nights} night${nights !== 1 ? 's' : ''}`} />
        </div>

        {booking.notes && (
          <div
            className="text-sm rounded-lg p-3 mt-4"
            style={{ background: 'var(--bg-canvas)', color: 'var(--text-secondary)' }}
          >
            {booking.notes}
          </div>
        )}

        <button
          onClick={() => { onViewInList(booking.guest_name ?? ''); onClose() }}
          className="flex items-center gap-1.5 text-sm font-medium hover:underline mt-5"
          style={{ color: 'var(--accent-blue)' }}
        >
          <ExternalLink className="w-3.5 h-3.5" />
          View in list
        </button>
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="font-medium text-right" style={{ color: 'var(--text-secondary)' }}>{value}</span>
    </div>
  )
}

// ── Calendar grid ────────────────────────────────────────────────────────────

export function BookingsCalendar({
  bookings,
  properties,
  onViewInList,
}: {
  bookings:     BookingRow[]
  properties:   PropertyOption[]
  onViewInList: (guestName: string) => void
}) {
  const groups = useMemo(
    () => properties.map((p) => ({ id: p.id, title: p.name })),
    [properties]
  )

  const items = useMemo(
    () =>
      bookings.map((b) => {
        const style = SOURCE_STYLE[b.source] ?? SOURCE_STYLE.other
        return {
          id: b.id,
          group: b.property_id,
          title: bookingTitle(b),
          start_time: dayjs(b.checkin_date).valueOf(),
          end_time: dayjs(b.checkout_date).valueOf(),
          canMove: false,   // Stage 1: read-only. Stage 2 enables this.
          canResize: false,
          itemProps: {
            style: {
              background: style.bg,
              color: style.fg,
              border: `1px solid ${style.border}`,
              opacity: STATUS_OPACITY[b.status] ?? 1,
              borderRadius: '4px',
              fontSize: '12px',
              fontWeight: 500,
            },
          },
        }
      }),
    [bookings]
  )

  const [selectedBooking, setSelectedBooking] = useState<BookingRow | null>(null)
  const [visibleRange, setVisibleRange] = useState(() => ({
    start: dayjs().subtract(7, 'day').valueOf(),
    end: dayjs().add(45, 'day').valueOf(),
  }))

  const handleItemClick = useCallback(
    (itemId: string) => {
      const booking = bookings.find((b) => b.id === itemId)
      if (booking) setSelectedBooking(booking)
    },
    [bookings]
  )

  // Stage 1: bounds tracking only, to inform a future lazy-load. The
  // page already fetches a 60-day-back/180-day-forward window, which
  // comfortably covers the default visible range — actual lazy fetching
  // on scroll-past-bounds is a Stage 2 enhancement once usage shows it's
  // needed at real portfolio scale.
  const handleBoundsChange = useCallback((canvasTimeStart: number, canvasTimeEnd: number) => {
    setVisibleRange({ start: canvasTimeStart, end: canvasTimeEnd })
  }, [])

  if (properties.length === 0) {
    return (
      <div
        className="rounded-xl flex items-center justify-center py-16 text-sm"
        style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
      >
        No active properties to show.
      </div>
    )
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      <Timeline
        groups={groups}
        items={items}
        defaultTimeStart={visibleRange.start}
        defaultTimeEnd={visibleRange.end}
        onBoundsChange={handleBoundsChange}
        onItemClick={handleItemClick}
        sidebarWidth={180}
        lineHeight={44}
        itemHeightRatio={0.75}
        canMove={false}
        canResize={false}
        stackItems
      >
        <TimelineMarkers>
          <TodayMarker>
            {({ styles }) => (
              <div style={{ ...styles, backgroundColor: 'var(--accent-gold)', width: '2px' }} />
            )}
          </TodayMarker>
        </TimelineMarkers>
      </Timeline>

      {selectedBooking && (
        <BookingDetailPanel
          booking={selectedBooking}
          onClose={() => setSelectedBooking(null)}
          onViewInList={onViewInList}
        />
      )}
    </div>
  )
}
