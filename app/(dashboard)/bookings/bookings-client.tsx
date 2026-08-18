'use client'

import { asJsonObject } from '@/lib/json'
import { useState, useTransition, useActionState, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Plus, RefreshCw, X, ChevronDown, ChevronUp,
  Calendar, Clock, AlertTriangle,
  CheckCircle2, Ban, HelpCircle, ExternalLink,
  Search, Download, LayoutList,
} from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { createBooking, cancelBooking, triggerSync } from './actions'
import { BookingsCalendar } from './bookings-calendar'
import { Dialog } from '@/components/ui/Dialog'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { RequiredMark } from '@/components/ui/RequiredMark'
import type { VacancyGap } from './page'
import type { BookingSource, BookingStatus, Json } from '@/types/database'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BookingRow {
  id:                   string
  property_id:          string
  guest_name:           string | null
  checkin_date:         string
  checkout_date:        string
  checkin_time:         string | null
  checkout_time:        string | null
  source:               BookingSource
  status:               BookingStatus
  notes:                string | null
  has_overlap_conflict: boolean
  created_at:           string
  ical_feed_id:         string | null
  external_source:      string | null
  stay_type:            'guest_stay' | 'owner_stay'
  properties:           { id: string; name: string; city: string | null; state: string | null } | null
  turnovers:            { id: string; status: string; checkout_datetime: string }
                       | { id: string; status: string; checkout_datetime: string }[]
                       | null
}

interface PropertyOption { id: string; name: string }

interface ConnectionRow {
  provider_id:   string
  status:        string
  last_used_at:  string | null
  // jsonb — narrowed with asJsonObject() before use, never indexed raw.
  metadata:      Json
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nightCount(checkin: string, checkout: string): number {
  return Math.round(
    (new Date(checkout).getTime() - new Date(checkin).getTime()) / 86_400_000
  )
}

function isToday(date: string): boolean {
  return new Date(date).toDateString() === new Date().toDateString()
}

function isTomorrow(date: string): boolean {
  const t = new Date()
  t.setDate(t.getDate() + 1)
  return new Date(date).toDateString() === t.toDateString()
}

function getDateLabel(date: string): { label: string; urgent: boolean } {
  if (isToday(date))    return { label: 'Today',    urgent: true }
  if (isTomorrow(date)) return { label: 'Tomorrow', urgent: false }
  return { label: formatDate(date, 'EEE MMM d'), urgent: false }
}

function getTurnover(row: BookingRow): { id: string; status: string } | null {
  return unwrapJoin(row.turnovers)
}

// ── Source badges ─────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<BookingSource, string> = {
  airbnb:      'Airbnb',
  vrbo:        'VRBO',
  booking_com: 'Booking.com',
  direct:      'Direct',
  manual:      'Manual',
  // See bookings-calendar.tsx's SOURCE_LABELS comment — 'ownerrez' is a live
  // enum label (20260616141406_add_ownerrez_booking_source.sql) with no
  // current write path, kept here so it doesn't fall through to `undefined`.
  ownerrez:    'OwnerRez',
  other:       'Other',
}

type BadgeTone = 'green' | 'amber' | 'red' | 'blue' | 'gold' | 'slate'

const SOURCE_COLORS: Record<BookingSource, BadgeTone> = {
  airbnb:      'red',
  vrbo:        'blue',
  booking_com: 'blue',
  direct:      'green',
  manual:      'gold',
  ownerrez:    'slate',
  other:       'slate',
}

// `source` (above) is the OTA/channel the guest booked through — this is a
// separate signal: which system synced the row into FieldStay at all.
// Distinct from `source` because a single channel (e.g. Airbnb) can arrive
// via more than one path (a direct Hospitable/OwnerRez connection, or a
// plain iCal feed) with different implications for whether FieldStay can
// safely edit the booking. Returns null for a booking FieldStay itself
// owns (no external_source, no ical_feed_id) — nothing to badge there,
// the channel badge above already reads "Manual" in that case.
function getSyncOriginLabel(booking: Pick<BookingRow, 'external_source' | 'ical_feed_id'>): string | null {
  if (booking.external_source === 'hospitable') return 'Hospitable'
  if (booking.external_source === 'ownerrez')   return 'OwnerRez'
  if (booking.external_source === 'hostex')     return 'Hostex'
  if (booking.external_source === 'hostaway')   return 'Hostaway'
  if (booking.ical_feed_id !== null)            return 'iCal'
  return null
}

// ── Status display ────────────────────────────────────────────────────────────

const STATUS_ICON: Record<BookingStatus, React.ReactNode> = {
  confirmed:  <CheckCircle2 className="w-3.5 h-3.5" />,
  tentative:  <HelpCircle   className="w-3.5 h-3.5" />,
  blocked:    <Ban          className="w-3.5 h-3.5" />,
  cancelled:  <X            className="w-3.5 h-3.5" />,
}

const STATUS_STYLE: Record<BookingStatus, React.CSSProperties> = {
  confirmed:  { color: 'var(--accent-green)', background: 'var(--accent-green-dim)' },
  tentative:  { color: 'var(--accent-amber)', background: 'var(--accent-amber-dim)' },
  blocked:    { color: 'var(--text-muted)',   background: 'var(--bg-raised)' },
  cancelled:  { color: 'var(--accent-red)',   background: 'var(--accent-red-dim)' },
}

const TURNOVER_STATUS_COLORS: Record<string, string> = {
  pending_assignment: 'var(--accent-amber)',
  assigned:           'var(--accent-blue)',
  in_progress:        'var(--accent-gold)',
  completed:          'var(--accent-green)',
  cancelled:          'var(--text-muted)',
}

// ── Booking card ──────────────────────────────────────────────────────────────

function BookingCard({
  booking,
  onCancel,
}: {
  booking:  BookingRow
  onCancel: (id: string) => void
}) {
  const [expanded, setExpanded]     = useState(false)
  const [confirm,  setConfirm]      = useState(false)
  const [cancelling, startCancel]   = useTransition()

  const property    = booking.properties
  const turnover    = getTurnover(booking)
  const nights      = nightCount(booking.checkin_date, booking.checkout_date)
  const checkin     = getDateLabel(booking.checkin_date)
  const originLabel = getSyncOriginLabel(booking)
  const isBlocked = booking.status === 'blocked'
  const isCancelled = booking.status === 'cancelled'

  return (
    <div
      className={cn('rounded-xl border transition-all', isCancelled && 'opacity-50')}
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
    >
      {/* Main row */}
      <button
        type="button"
        className="flex items-start gap-3 px-4 py-3 w-full text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {/* Date column */}
        <div className="flex-shrink-0 w-14 text-center">
          <div
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: checkin.urgent ? 'var(--accent-gold)' : 'var(--text-muted)' }}
          >
            {new Date(booking.checkin_date).toLocaleDateString('en-US', { month: 'short' })}
          </div>
          <div
            className="text-2xl font-bold leading-none"
            style={{ color: checkin.urgent ? 'var(--accent-gold)' : 'var(--text-primary)' }}
          >
            {new Date(booking.checkin_date).getDate()}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {nights}n
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {isBlocked
                    ? 'Blocked / Unavailable'
                    : (booking.guest_name ?? 'Guest')}
                </span>

                {/* Status badge */}
                <span
                  className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
                  style={STATUS_STYLE[booking.status]}
                >
                  {STATUS_ICON[booking.status]}
                  {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                </span>

                {/* Source badge */}
                {!isBlocked && (
                  <Badge tone={SOURCE_COLORS[booking.source]} className="text-xs">
                    {SOURCE_LABELS[booking.source]}
                  </Badge>
                )}

                {/* Sync origin badge — which system synced this booking in
                    (Hospitable / OwnerRez / iCal), distinct from the channel
                    badge above. Omitted for a booking FieldStay owns directly. */}
                {originLabel && (
                  <Badge tone="slate" className="text-xs" title="Synced via this integration">
                    {originLabel}
                  </Badge>
                )}

                {/* Owner stay badge — owner's own personal-use stay, not a
                    paying guest reservation. Still gets a turnover. */}
                {booking.stay_type === 'owner_stay' && (
                  <Badge tone="amber" className="text-xs">
                    Owner Stay
                  </Badge>
                )}

                {/* Overlap conflict badge */}
                {booking.has_overlap_conflict && (
                  <span
                    className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
                    style={{
                      background: 'var(--accent-red-dim)',
                      color:      'var(--accent-red)',
                      border:     '1px solid var(--accent-red)',
                    }}
                    title="This booking's dates overlap another confirmed booking at this property"
                  >
                    <AlertTriangle className="w-3 h-3" />
                    Possible double-booking
                  </span>
                )}
              </div>

              {/* Property name */}
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {property?.name ?? '—'}
                {checkin.urgent && (
                  <span className="ml-2 font-semibold" style={{ color: 'var(--accent-gold)' }}>
                    {checkin.label}
                  </span>
                )}
              </p>
            </div>

            {/* Right side: dates + turnover + chevron */}
            <div className="flex items-center gap-3 flex-shrink-0">
              {/* Date range */}
              <div className="hidden sm:flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                <Calendar className="w-3 h-3" />
                {formatDate(booking.checkin_date, 'MMM d')}
                <span>→</span>
                {formatDate(booking.checkout_date, 'MMM d')}
              </div>

              {/* Turnover link */}
              {turnover && (
                <Link
                  href={`/turnovers/${turnover.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="hidden sm:flex items-center gap-1 text-xs px-2 py-0.5 rounded-full transition-opacity hover:opacity-80"
                  style={{
                    background: 'var(--bg-raised)',
                    color: TURNOVER_STATUS_COLORS[turnover.status] ?? 'var(--text-muted)',
                    border: '1px solid var(--border)',
                  }}
                  title="View turnover"
                >
                  <RefreshCw className="w-2.5 h-2.5" />
                  Turnover
                </Link>
              )}

              {expanded
                ? <ChevronUp   className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                : <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
            </div>
          </div>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3" style={{ borderColor: 'var(--border)' }}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <Detail label="Check-in"  value={`${formatDate(booking.checkin_date)}${booking.checkin_time ? ` at ${booking.checkin_time}` : ''}`} />
            <Detail label="Check-out" value={`${formatDate(booking.checkout_date)}${booking.checkout_time ? ` at ${booking.checkout_time}` : ''}`} />
            <Detail label="Nights"    value={`${nights} night${nights !== 1 ? 's' : ''}`} />
            {property && (
              <Detail
                label="Property"
                value={[property.name, property.city, property.state].filter(Boolean).join(', ')}
              />
            )}
          </div>

          {booking.notes && (
            <div
              className="text-sm rounded-lg p-3"
              style={{ background: 'var(--bg-canvas)', color: 'var(--text-secondary)' }}
            >
              {booking.notes}
            </div>
          )}

          {/* Turnover link (mobile) + actions */}
          <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
            <div className="flex items-center gap-2">
              {turnover && (
                <Link
                  href={`/turnovers/${turnover.id}`}
                  className="flex items-center gap-1.5 text-xs font-medium hover:underline"
                  style={{ color: 'var(--accent-blue)' }}
                >
                  <ExternalLink className="w-3 h-3" />
                  View Turnover ({turnover.status.replace('_', ' ')})
                </Link>
              )}
              {!turnover && !isBlocked && !isCancelled && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  No turnover generated yet
                </span>
              )}
            </div>

            {!isCancelled && (
              !confirm ? (
                <button
                  onClick={() => setConfirm(true)}
                  className="text-xs hover:opacity-80 transition-opacity"
                  style={{ color: 'var(--accent-red)' }}
                >
                  Cancel Booking
                </button>
              ) : (
                <div className="flex items-center gap-2 text-xs">
                  <span style={{ color: 'var(--text-secondary)' }}>Cancel this booking?</span>
                  <button
                    disabled={cancelling}
                    onClick={() => startCancel(async () => {
                      await cancelBooking(booking.id)
                      onCancel(booking.id)
                    })}
                    className="font-medium hover:opacity-80"
                    style={{ color: 'var(--accent-red)' }}
                  >
                    {cancelling ? 'Cancelling…' : 'Yes, cancel'}
                  </button>
                  <button
                    onClick={() => setConfirm(false)}
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Never mind
                  </button>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-sm font-medium mt-0.5" style={{ color: 'var(--text-secondary)' }}>{value}</p>
    </div>
  )
}

// ── Add booking modal ─────────────────────────────────────────────────────────

function AddBookingModal({
  properties,
  onClose,
  onSuccess,
  initialPropertyId,
  initialCheckinDate,
}: {
  properties:          PropertyOption[]
  onClose:             () => void
  onSuccess:           () => void
  initialPropertyId?:  string
  initialCheckinDate?: string
}) {
  const [state, action, pending] = useActionState(createBooking, null)
  const [checkinVal, setCheckinVal] = useState(initialCheckinDate ?? '')
  const todayStr = new Date().toISOString().split('T')[0]!

  if (state?.success) { onSuccess(); onClose(); return null }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Log Non-Synced Booking"
      footer={
        <>
          <Button type="submit" form="add-booking-form" disabled={pending} className="flex-1">
            {pending ? 'Saving…' : 'Add Booking'}
          </Button>
          <Button type="button" onClick={onClose} variant="ghost">Cancel</Button>
        </>
      }
    >
        {state?.error && (
          <div
            className="text-sm rounded-lg px-3 py-2 mb-4"
            style={{ color: 'var(--accent-red)', background: 'var(--accent-red-dim)' }}
          >
            {state.error}
          </div>
        )}

        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Use this form for bookings that won&apos;t appear via your iCal feed
          (direct reservations, social media enquiries, etc.). A turnover will be automatically created.
        </p>

        <form id="add-booking-form" action={action} className="space-y-4">
          <div>
            <label htmlFor="bookings-client-property" className="label">Property <RequiredMark /></label>
            <select id="bookings-client-property" name="property_id" required className="input" defaultValue={initialPropertyId ?? ''}>
              <option value="">Select property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="bookings-client-check-in" className="label">Check-in <RequiredMark /></label>
              <Input id="bookings-client-check-in"
                name="checkin_date"
                type="date"
                required
                min={todayStr}
                value={checkinVal}
                onChange={(e) => setCheckinVal(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="bookings-client-check-out" className="label">Check-out <RequiredMark /></label>
              <Input id="bookings-client-check-out" name="checkout_date" type="date" required min={checkinVal || todayStr} />
            </div>
          </div>

          <div>
            <label htmlFor="bookings-client-guest-name" className="label">Guest Name</label>
            <Input id="bookings-client-guest-name" name="guest_name" type="text" placeholder="Optional" />
          </div>

          <div>
            <label htmlFor="bookings-client-source" className="label">Source</label>
            <select id="bookings-client-source" name="source" className="input" defaultValue="direct">
              <option value="direct">Direct Booking</option>
              <option value="airbnb">Airbnb</option>
              <option value="vrbo">VRBO</option>
              <option value="booking_com">Booking.com</option>
              <option value="manual">Manual Entry</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div>
            <label htmlFor="bookings-client-notes" className="label">Notes</label>
            <textarea id="bookings-client-notes"
              name="notes"
              rows={2}
              className="input resize-none"
              placeholder="Any notes about this booking…"
            />
          </div>

          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            A turnover will be automatically generated for this booking.
          </p>
        </form>
    </Dialog>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

// ── Extracted sub-views & state ──────────────────────────────────────────────

interface BookingFilters {
  filterProperty: string
  setFilterProperty: (v: string) => void
  filterStatus: 'all' | 'active' | BookingStatus
  setFilterStatus: (v: 'all' | 'active' | BookingStatus) => void
  filterSource: 'all' | BookingSource
  setFilterSource: (v: 'all' | BookingSource) => void
  searchQuery: string
  setSearchQuery: (v: string) => void
  showPast: boolean
  setShowPast: (v: boolean) => void
  hasFilters: boolean
  reset: () => void
}

/** All six filter inputs plus the derived `hasFilters` flag and a reset. */
function useBookingFilters(): BookingFilters {
  const [filterProperty, setFilterProperty] = useState('all')
  const [filterStatus,   setFilterStatus]   = useState<'all' | 'active' | BookingStatus>('active')
  const [filterSource,   setFilterSource]   = useState<'all' | BookingSource>('all')
  const [searchQuery,    setSearchQuery]    = useState('')
  const [showPast,       setShowPast]       = useState(false)

  return {
    filterProperty, setFilterProperty,
    filterStatus,   setFilterStatus,
    filterSource,   setFilterSource,
    searchQuery,    setSearchQuery,
    showPast,       setShowPast,
    hasFilters:
      filterProperty !== 'all' ||
      filterStatus   !== 'all' ||
      filterSource   !== 'all' ||
      searchQuery.trim() !== '',
    reset: () => {
      setFilterProperty('all')
      setFilterStatus('all')
      setFilterSource('all')
      setSearchQuery('')
    },
  }
}

/** Health pill for one connected PMS provider. */
function ConnectionPill({ connection }: Readonly<{ connection: ConnectionRow }>) {
  const isHealthy = connection.status === 'active'
  const lastSynced = connection.last_used_at
    ? ` — last synced ${new Date(connection.last_used_at).toLocaleString()}`
    : ''
  const lastSyncError = asJsonObject(connection.metadata)?.last_sync_error
  const syncError = typeof lastSyncError === 'string' ? lastSyncError : 'connection needs attention'
  const title = isHealthy
    ? `${connection.provider_id} connected${lastSynced}`
    : `${connection.provider_id}: ${syncError}`

  return (
    <span
      title={title}
      className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
      style={{
        background: isHealthy ? 'var(--accent-green-dim)' : 'var(--accent-red-dim)',
        color:      isHealthy ? 'var(--accent-green)'     : 'var(--accent-red)',
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'currentColor' }} />
      {connection.provider_id}
    </span>
  )
}

function BookingsEmptyState({
  hasAnyBookings,
  syncing,
  onAdd,
  onSync,
}: Readonly<{ hasAnyBookings: boolean; syncing: boolean; onAdd: () => void; onSync: () => void }>) {
  return (
    <Card className="text-center py-16 max-w-md mx-auto mt-4">
      <Calendar className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
      <h3 className="font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
        {hasAnyBookings ? 'No bookings match your filters' : 'No bookings yet'}
      </h3>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        {hasAnyBookings
          ? 'Try adjusting your filters or showing past bookings.'
          : 'Add iCal feeds to your properties to automatically sync bookings, or add one manually.'}
      </p>
      {!hasAnyBookings && (
        <div className="flex gap-2 justify-center">
          <Button onClick={onAdd} className="text-sm">
            <Plus className="w-3.5 h-3.5" /> Add Booking
          </Button>
          <Button onClick={onSync} disabled={syncing} variant="secondary" className="text-sm">
            <RefreshCw className={cn('w-3.5 h-3.5', syncing && 'animate-spin')} />
            {syncing ? 'Syncing…' : 'Sync iCal'}
          </Button>
        </div>
      )}
    </Card>
  )
}

function BookingsList({
  bookings,
  hasAnyBookings,
  syncing,
  onAdd,
  onSync,
  onCancel,
}: Readonly<{
  bookings: BookingRow[]
  hasAnyBookings: boolean
  syncing: boolean
  onAdd: () => void
  onSync: () => void
  onCancel: (id: string) => void
}>) {
  if (bookings.length === 0) {
    return (
      <BookingsEmptyState
        hasAnyBookings={hasAnyBookings}
        syncing={syncing}
        onAdd={onAdd}
        onSync={onSync}
      />
    )
  }
  return (
    <div className="space-y-2">
      {bookings.map((booking) => (
        <BookingCard key={booking.id} booking={booking} onCancel={onCancel} />
      ))}
    </div>
  )
}

function TodayStatsStrip({
  checkinsToday,
  checkoutsToday,
}: Readonly<{ checkinsToday: BookingRow[]; checkoutsToday: BookingRow[] }>) {
  if (checkinsToday.length === 0 && checkoutsToday.length === 0) return null

  return (
    <div
      className="flex items-center gap-6 px-4 py-3 rounded-xl mb-5"
      style={{ background: 'var(--accent-gold-dim)', border: '1px solid rgba(252,209,22,0.25)' }}
    >
      {checkinsToday.length > 0 && (
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--accent-gold)' }}>
            {checkinsToday.length} check-in{checkinsToday.length !== 1 ? 's' : ''} today
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {checkinsToday.map((b) => unwrapJoin(b.properties)?.name ?? '—').join(', ')}
          </span>
        </div>
      )}
      {checkoutsToday.length > 0 && (
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {checkoutsToday.length} check-out{checkoutsToday.length !== 1 ? 's' : ''} today
          </span>
        </div>
      )}
    </div>
  )
}

interface FilterCriteria {
  todayStr:       string
  showPast:       boolean
  filterProperty: string
  filterStatus:   'all' | 'active' | BookingStatus
  filterSource:   'all' | BookingSource
  searchQuery:    string
}

/** The list's filter predicate, named and pulled out of the component so the
 *  rules are readable (and testable) on their own. */
function matchesBookingFilters(b: BookingRow, c: FilterCriteria): boolean {
  if (!c.showPast && b.checkout_date < c.todayStr) return false
  if (c.filterProperty !== 'all' && b.property_id !== c.filterProperty) return false
  if (c.filterStatus === 'active' && b.status === 'cancelled') return false
  if (c.filterStatus !== 'all' && c.filterStatus !== 'active' && b.status !== c.filterStatus) return false
  if (c.filterSource !== 'all' && b.source !== c.filterSource) return false
  const q = c.searchQuery.trim().toLowerCase()
  if (q && !(b.guest_name ?? '').toLowerCase().includes(q)) return false
  return true
}

function BookingsHeader({
  connections,
  syncing,
  onSync,
  onAdd,
}: Readonly<{ connections: ConnectionRow[]; syncing: boolean; onSync: () => void; onAdd: () => void }>) {
  return (
    <div className="page-header flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <h1 className="page-title">Bookings</h1>
          {connections.length > 0 && (
            <div className="flex items-center gap-1.5">
              {connections.map((c) => <ConnectionPill key={c.provider_id} connection={c} />)}
            </div>
          )}
        </div>
        <p className="page-subtitle">
          Log bookings not synced automatically — direct, social media, or phone.
          Connected accounts sync in real time via webhook, with a backup sync
          every 30 minutes.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Button onClick={onSync} disabled={syncing} variant="secondary" title="Sync iCal feeds now">
          <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
          {syncing ? 'Syncing…' : 'Sync'}
        </Button>
        <Button onClick={onAdd}>
          <Plus className="w-4 h-4" />
          Add Booking
        </Button>
      </div>
    </div>
  )
}

/** CSV export of whatever the current filters produced. */
function exportBookingsCsv(rows: BookingRow[]): void {
  const lines = ['Guest,Property,Check-in,Check-out,Status,Source']
  for (const b of rows) {
    const propertyName = b.properties?.name ?? ''
    lines.push(`"${b.guest_name ?? ''}","${propertyName}",${b.checkin_date},${b.checkout_date},${b.status},${b.source}`)
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `bookings-${new Date().toISOString().split('T')[0]}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function BookingsClient({
  bookings,
  properties,
  connections,
  vacancyGaps,
}: {
  bookings:    BookingRow[]
  properties:  PropertyOption[]
  connections: ConnectionRow[]
  vacancyGaps: VacancyGap[]
}) {
  const router = useRouter()

  const [showAdd,          setShowAdd]         = useState(false)
  const [syncing,          startSync]          = useTransition()
  const [viewMode,         setViewMode]        = useState<'list' | 'calendar'>('list')
  const {
    filterProperty, setFilterProperty,
    filterStatus,   setFilterStatus,
    filterSource,   setFilterSource,
    searchQuery,    setSearchQuery,
    showPast,       setShowPast,
    hasFilters,
  } = useBookingFilters()
  const [localBookings,    setLocalBookings]   = useState(bookings)
  const [justAdded,        setJustAdded]       = useState(false)
  const [calendarPrefill,  setCalendarPrefill] = useState<{ propertyId: string; checkinDate: string } | null>(null)

  // Re-sync local (optimistically-mutable) state when the server-provided
  // `bookings` prop changes (e.g. after router.refresh()) — compared during
  // render rather than in a useEffect so it lands in the same render pass.
  const [prevBookings, setPrevBookings] = useState(bookings)
  if (bookings !== prevBookings) {
    setPrevBookings(bookings)
    setLocalBookings(bookings)
  }

  useEffect(() => {
    if (!justAdded) return
    const t = setTimeout(() => setJustAdded(false), 4000)
    return () => clearTimeout(t)
  }, [justAdded])

  const todayStr = new Date().toISOString().split('T')[0]!  // 'YYYY-MM-DD'

  const filtered = useMemo(
    () => localBookings.filter((b) =>
      matchesBookingFilters(b, {
        todayStr, showPast, filterProperty, filterStatus, filterSource, searchQuery,
      })
    ),
    [localBookings, showPast, filterProperty, filterStatus, filterSource, searchQuery, todayStr],
  )

  // Stats
  const checkinsToday = localBookings.filter((b) => isToday(b.checkin_date) && b.status === 'confirmed')
  const checkoutsToday = localBookings.filter((b) => isToday(b.checkout_date) && b.status === 'confirmed')

  const handleCancel = (id: string) => {
    setLocalBookings((prev) =>
      prev.map((b) => b.id === id ? { ...b, status: 'cancelled' as BookingStatus } : b)
    )
  }

  const handleSync = () => {
    startSync(async () => { await triggerSync() })
  }

  const handleExportCsv = () => exportBookingsCsv(filtered)

  return (
    <div>
      <BookingsHeader
        connections={connections}
        syncing={syncing}
        onSync={handleSync}
        onAdd={() => setShowAdd(true)}
      />

      {/* Success banner */}
      {justAdded && (
        <div
          className="flex items-center gap-2 px-4 py-3 rounded-xl mb-5"
          style={{
            background: 'var(--accent-green-dim)',
            border: '1px solid rgba(47,217,140,0.25)',
            color: 'var(--accent-green)',
          }}
        >
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm font-medium">Booking added — a turnover will be generated automatically.</span>
        </div>
      )}

      <TodayStatsStrip checkinsToday={checkinsToday} checkoutsToday={checkoutsToday} />

      {/* Filters */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search guest name…"
            className="pl-8 text-sm py-1.5 w-auto"
          />
        </div>

        {properties.length > 1 && (
          <select
            value={filterProperty}
            onChange={(e) => setFilterProperty(e.target.value)}
            className="input text-sm py-1.5 w-auto"
          >
            <option value="all">All Properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}

        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}
          className="input text-sm py-1.5 w-auto"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active only</option>
          <option value="confirmed">Confirmed</option>
          <option value="tentative">Tentative</option>
          <option value="blocked">Blocked</option>
          <option value="cancelled">Cancelled</option>
        </select>

        <select
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value as typeof filterSource)}
          className="input text-sm py-1.5 w-auto"
        >
          <option value="all">All Sources</option>
          {(Object.keys(SOURCE_LABELS) as BookingSource[]).map((s) => (
            <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
          ))}
        </select>

        <Button
          onClick={() => setShowPast(!showPast)}
          variant="ghost"
          className={cn('text-sm py-1.5', showPast && 'text-primary-themed')}
          style={showPast ? { color: 'var(--accent-gold)' } : { color: 'var(--text-muted)' }}
        >
          {showPast ? 'Hiding past' : 'Show past'}
        </Button>

        {hasFilters && (
          <Button
            onClick={() => {
              setFilterProperty('all')
              setFilterStatus('all')
              setFilterSource('all')
              setSearchQuery('')
            }}
            variant="ghost"
            className="text-xs py-1.5"
            style={{ color: 'var(--text-muted)' }}
          >
            <X className="w-3 h-3" /> Clear
          </Button>
        )}

        <Button onClick={handleExportCsv} variant="ghost" className="text-xs py-1.5" style={{ color: 'var(--text-muted)' }}>
          <Download className="w-3 h-3" /> Export CSV
        </Button>

        <div
          className="flex items-center gap-0.5 rounded-lg p-0.5 ml-auto"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
        >
          <button
            onClick={() => setViewMode('list')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={{
              background: viewMode === 'list' ? 'var(--bg-card)' : 'transparent',
              color:      viewMode === 'list' ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow:  viewMode === 'list' ? '0 1px 2px rgba(0,0,0,0.15)' : 'none',
            }}
            title="List view"
          >
            <LayoutList className="w-3.5 h-3.5" />
            List
          </button>
          <button
            onClick={() => setViewMode('calendar')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={{
              background: viewMode === 'calendar' ? 'var(--bg-card)' : 'transparent',
              color:      viewMode === 'calendar' ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow:  viewMode === 'calendar' ? '0 1px 2px rgba(0,0,0,0.15)' : 'none',
            }}
            title="Calendar view"
          >
            <Calendar className="w-3.5 h-3.5" />
            Calendar
          </button>
        </div>
      </div>

      {/* Count */}
      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
        {filtered.length} booking{filtered.length !== 1 ? 's' : ''}
        {hasFilters || showPast ? ` shown` : ` upcoming`}
      </p>

      {/* Booking list / calendar */}
      {viewMode === 'calendar' ? (
        <BookingsCalendar
          bookings={filtered}
          properties={properties}
          vacancyGaps={vacancyGaps}
          onViewInList={(guestName) => {
            setSearchQuery(guestName)
            setViewMode('list')
          }}
          onCanvasClick={(propertyId, checkinDate) => setCalendarPrefill({ propertyId, checkinDate })}
        />
      ) : (
        <BookingsList
          bookings={filtered}
          hasAnyBookings={localBookings.length > 0}
          syncing={syncing}
          onAdd={() => setShowAdd(true)}
          onSync={handleSync}
          onCancel={handleCancel}
        />
      )}

      {(showAdd || calendarPrefill) && (
        <AddBookingModal
          properties={properties}
          initialPropertyId={calendarPrefill?.propertyId}
          initialCheckinDate={calendarPrefill?.checkinDate}
          onClose={() => { setShowAdd(false); setCalendarPrefill(null) }}
          onSuccess={() => { setJustAdded(true); setCalendarPrefill(null); router.refresh() }}
        />
      )}
    </div>
  )
}
