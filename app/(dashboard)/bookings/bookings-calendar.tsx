'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Timeline, { TimelineMarkers, TodayMarker } from 'react-calendar-timeline'
import type { Id, TimelineItemBase } from 'react-calendar-timeline'
import dayjs from 'dayjs'
import { X, ExternalLink } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { useToast } from '@/components/dashboard-toast-provider'
import { updateBookingDates } from './calendar-actions'
import type { VacancyGap } from './page'
import type { BookingSource, BookingStatus } from '@/types/database'
import 'react-calendar-timeline/style.css'
import './bookings-calendar.css'

// ── Types ────────────────────────────────────────────────────────────────────
// Deliberately a subset of bookings-client.tsx's BookingRow — only the fields
// the grid and detail panel actually use.

interface BookingRow {
  id:              string
  property_id:     string
  guest_name:      string | null
  checkin_date:    string
  checkout_date:   string
  checkin_time:    string | null
  checkout_time:   string | null
  status:          BookingStatus
  source:          BookingSource
  notes:           string | null
  ical_feed_id:    string | null
  external_source: string | null
  properties:      { id: string; name: string; city: string | null; state: string | null } | null
  turnovers:       { id: string; status: string; checkout_datetime: string }
                  | { id: string; status: string; checkout_datetime: string }[]
                  | null
}

// A booking is owned by FieldStay — and therefore safe to drag/resize —
// only if it didn't arrive via an external system of record. iCal feeds
// (ical_feed_id) and direct integrations like OwnerRez (external_source)
// are both sources of truth FieldStay doesn't own; dragging one would
// silently diverge from the real reservation until the next sync
// overwrites the drag with no indication to the PM that it was ever real.
function isManualBooking(b: BookingRow): boolean {
  return b.ical_feed_id === null && b.external_source === null
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

function getTurnover(b: BookingRow): { id: string; status: string } | null {
  if (!b.turnovers) return null
  return Array.isArray(b.turnovers) ? (b.turnovers[0] ?? null) : b.turnovers
}

// Mirrors bookings-client.tsx's TURNOVER_STATUS_COLORS exactly — same
// status reads as the same color whether you're in the list view's
// turnover link or the calendar's checkout dot. No CSS var for "purple"
// exists in this codebase, so in_progress reuses gold rather than
// introducing a new hardcoded hex (CLAUDE.md: no hardcoded colors).
const TURNOVER_STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  pending_assignment: { color: 'var(--accent-amber)', label: 'Needs crew' },
  assigned:            { color: 'var(--accent-blue)',  label: 'Assigned' },
  in_progress:         { color: 'var(--accent-gold)',  label: 'In progress' },
  completed:           { color: 'var(--accent-green)', label: 'Completed' },
  flagged:             { color: 'var(--accent-red)',   label: 'Flagged' },
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
      role="button"
      tabIndex={0}
      aria-label="Close booking details"
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose() } }}
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
  vacancyGaps,
  onViewInList,
  onCanvasClick,
}: {
  bookings:      BookingRow[]
  properties:    PropertyOption[]
  vacancyGaps:   VacancyGap[]
  onViewInList:  (guestName: string) => void
  onCanvasClick: (propertyId: string, checkinDate: string) => void
}) {
  const { push } = useToast()
  const router = useRouter()

  const groups = useMemo(
    () => properties.map((p) => ({ id: p.id, title: p.name })),
    [properties]
  )

  const items = useMemo(
    () =>
      bookings.map((b) => {
        const style = SOURCE_STYLE[b.source] ?? SOURCE_STYLE.other
        const isManual = isManualBooking(b)
        return {
          id: b.id,
          group: b.property_id,
          title: bookingTitle(b),
          start_time: dayjs(b.checkin_date).valueOf(),
          end_time: dayjs(b.checkout_date).valueOf(),
          // Only manually-entered bookings are owned by FieldStay — see
          // isManualBooking(). Bookings synced from an iCal feed or an
          // integration like OwnerRez render here but are never draggable.
          canMove: isManual,
          canResize: isManual ? ('both' as const) : false,
          canChangeGroup: false,   // a booking never moves to a different property
          itemProps: {
            style: {
              background: style.bg,
              color: style.fg,
              border: `1px ${isManual ? 'dashed' : 'solid'} ${style.border}`,
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

  // Synthetic items appended to the real booking items above — same array,
  // same Timeline render pipeline, distinguished only by an id prefix. Kept
  // visually tiny/secondary (12px dot, dashed outline) so booking bars stay
  // the primary thing the eye lands on.
  const turnoverItems = useMemo(() => {
    return bookings.flatMap((b) => {
      const turnover = getTurnover(b)
      if (!turnover || turnover.status === 'cancelled') return []
      const config = TURNOVER_STATUS_CONFIG[turnover.status]
      if (!config) return []

      const checkoutMs = dayjs(b.checkout_date).valueOf()
      return [{
        id: `turnover-${turnover.id}`,
        group: b.property_id,
        title: config.label,
        start_time: checkoutMs,
        end_time: checkoutMs + 3 * 60 * 60 * 1000, // visual width only, not a real duration
        canMove: false,
        canResize: false,
        itemProps: {
          style: {
            background: config.color,
            opacity: 0.85,
            border: 'none',
            borderRadius: '50%',
            width: '12px',
            height: '12px',
            color: 'transparent', // icon-only, no text label inside the dot
          },
        },
      }]
    })
  }, [bookings])

  const gapItems = useMemo(() => {
    return vacancyGaps.map((gap, i) => {
      const midpoint = (dayjs(gap.gap_start).valueOf() + dayjs(gap.gap_end).valueOf()) / 2
      return {
        id: `gap-${gap.property_id}-${i}`,
        group: gap.property_id,
        title: `${gap.candidates.length} maintenance item(s) could fit this window`,
        start_time: midpoint - 12 * 60 * 60 * 1000,
        end_time: midpoint + 12 * 60 * 60 * 1000,
        canMove: false,
        canResize: false,
        itemProps: {
          style: {
            background: 'transparent',
            border: '2px dashed var(--accent-amber)',
            borderRadius: '4px',
            color: 'var(--accent-amber)',
            fontSize: '10px',
          },
        },
      }
    })
  }, [vacancyGaps])

  const allItems = useMemo(
    () => [...items, ...turnoverItems, ...gapItems],
    [items, turnoverItems, gapItems]
  )

  const [selectedBooking, setSelectedBooking] = useState<BookingRow | null>(null)
  const [visibleRange, setVisibleRange] = useState(() => ({
    start: dayjs().subtract(7, 'day').valueOf(),
    end: dayjs().add(45, 'day').valueOf(),
  }))

  const handleItemClick = useCallback(
    (itemId: string) => {
      if (itemId.startsWith('turnover-')) {
        router.push(`/turnovers/${itemId.replace('turnover-', '')}`)
        return
      }
      if (itemId.startsWith('gap-')) {
        router.push('/maintenance')
        return
      }
      const booking = bookings.find((b) => b.id === itemId)
      if (booking) setSelectedBooking(booking)
    },
    [bookings, router]
  )

  // Stage 1: bounds tracking only, to inform a future lazy-load. The
  // page already fetches a 60-day-back/180-day-forward window, which
  // comfortably covers the default visible range — actual lazy fetching
  // on scroll-past-bounds is a Stage 2 enhancement once usage shows it's
  // needed at real portfolio scale.
  const handleBoundsChange = useCallback((canvasTimeStart: number, canvasTimeEnd: number) => {
    setVisibleRange({ start: canvasTimeStart, end: canvasTimeEnd })
  }, [])

  // Client-side pre-check so a drag/resize snaps back instantly on an
  // invalid drop instead of waiting on a server round-trip. The server
  // action re-validates authoritatively — this only protects UX latency.
  //
  // `item` here is the library's own TimelineItemBase, not our BookingRow,
  // so external-source/ical provenance must be looked up from `bookings`.
  const moveResizeValidator = useCallback(
    (
      action: 'move' | 'resize',
      item: TimelineItemBase<number>,
      time: number,
      resizeEdge?: 'left' | 'right' | null
    ): number => {
      const booking = bookings.find((b) => b.id === item.id)
      const originalBoundary =
        action === 'move'
          ? item.start_time
          : resizeEdge === 'left' ? item.start_time : item.end_time

      // canMove/canResize already gate interaction for non-manual bookings,
      // but this is the correctness backstop — never let a synced booking's
      // dates change client-side under any path.
      if (!booking || !isManualBooking(booking)) return originalBoundary

      // Snap to whole days — this is a nightly-stay calendar, not hourly
      const snapped = dayjs(time).startOf('day').valueOf()

      // Reject moving/resizing into the past — a true no-op, not just a
      // visual snap, so the rejected drag never reaches the server
      if (snapped < dayjs().startOf('day').valueOf()) return originalBoundary

      const proposedStart =
        action === 'move' ? snapped : resizeEdge === 'left' ? snapped : item.start_time
      const proposedEnd =
        action === 'move'
          ? snapped + (item.end_time - item.start_time)
          : resizeEdge === 'right' ? snapped : item.end_time

      if (proposedEnd <= proposedStart) return originalBoundary

      // Client-side overlap pre-check against other bookings on the same
      // property. detectAndFlagOverlaps() remains the authoritative,
      // server-side recheck after the move/resize actually persists.
      const wouldOverlap = bookings.some((other) => {
        if (other.id === booking.id || other.property_id !== booking.property_id) return false
        if (other.status === 'cancelled') return false
        const otherStart = dayjs(other.checkin_date).valueOf()
        const otherEnd = dayjs(other.checkout_date).valueOf()
        return proposedStart < otherEnd && otherStart < proposedEnd
      })

      if (wouldOverlap) return originalBoundary

      return snapped
    },
    [bookings]
  )

  const handleItemMove = useCallback(
    async (itemId: Id, dragTime: number) => {
      const booking = bookings.find((b) => b.id === itemId)
      if (!booking) return
      const duration = dayjs(booking.checkout_date).valueOf() - dayjs(booking.checkin_date).valueOf()
      const newCheckin  = dayjs(dragTime).format('YYYY-MM-DD')
      const newCheckout = dayjs(dragTime + duration).format('YYYY-MM-DD')
      const result = await updateBookingDates(String(itemId), newCheckin, newCheckout)
      if (result.error) {
        push({
          title:    'Booking move not saved',
          subtitle: result.error,
          href:     '/bookings',
          severity: 'red',
        })
      }
    },
    [bookings, push]
  )

  const handleItemResize = useCallback(
    async (itemId: Id, time: number, edge: 'left' | 'right') => {
      const booking = bookings.find((b) => b.id === itemId)
      if (!booking) return
      const newDate = dayjs(time).format('YYYY-MM-DD')
      const newCheckin  = edge === 'left'  ? newDate : booking.checkin_date
      const newCheckout = edge === 'right' ? newDate : booking.checkout_date
      const result = await updateBookingDates(String(itemId), newCheckin, newCheckout)
      if (result.error) {
        push({
          title:    'Booking resize not saved',
          subtitle: result.error,
          href:     '/bookings',
          severity: 'red',
        })
      }
    },
    [bookings, push]
  )

  const handleCanvasClick = useCallback(
    (groupId: Id, time: number) => {
      onCanvasClick(String(groupId), dayjs(time).startOf('day').format('YYYY-MM-DD'))
    },
    [onCanvasClick]
  )

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
        items={allItems}
        defaultTimeStart={visibleRange.start}
        defaultTimeEnd={visibleRange.end}
        onBoundsChange={handleBoundsChange}
        onItemClick={handleItemClick}
        onItemMove={handleItemMove}
        onItemResize={handleItemResize}
        onCanvasClick={handleCanvasClick}
        moveResizeValidator={moveResizeValidator}
        dragSnap={24 * 60 * 60 * 1000}
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
