'use client'

import { useState, useMemo, useSyncExternalStore }  from 'react'
import { useLiveQuery }   from 'dexie-react-hooks'
import { useDexieDb }     from '@/lib/dexie/context'

import Link                              from 'next/link'
import { AlertCircle, MapPin, Clock, MessageCircle, PartyPopper } from 'lucide-react'
import { cn }                            from '@/lib/utils'
import { useCrewContext }                from '@/lib/crew/crew-context'
import { distanceMiles }                 from '@/lib/geocoding'
import type { CrewWorkOrderRow }         from '@/lib/dexie/schema'

const AVG_DRIVE_SPEED_MPH = 30

// Stable identity for the useLiveQuery(...) ?? fallback below — a fresh `[]`
// literal there would change reference every render while the query is
// still loading, defeating the assignedPropertyIds useMemo that depends on it.
const EMPTY_ROWS: never[] = []

type TurnoverRow = {
  id:                string
  status:            string
  priority:          string
  checkout_datetime: string
  checkin_datetime:  string
  window_minutes:    number | null
  property_id:       string
}

type PropertyRow = {
  id:      string
  name:    string
  address: string | null
  city:    string | null
  state:   string | null
  lat:     number | null
  lng:     number | null
}

function calcTravelSummary(turnovers: TurnoverRow[], propertyMap: Record<string, PropertyRow>) {
  const stops = turnovers.map((t) => propertyMap[t.property_id]).filter(Boolean) as PropertyRow[]
  if (stops.length < 2) return { miles: 0, minutes: 0, available: stops.length > 0 }

  let miles = 0
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!
    const b = stops[i + 1]!
    if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) {
      return { miles: 0, minutes: 0, available: false }
    }
    miles += distanceMiles(a.lat, a.lng, b.lat, b.lng)
  }
  const minutes = Math.round((miles / AVG_DRIVE_SPEED_MPH) * 60)
  return { miles, minutes, available: true }
}

function TurnoverCard({ t, property }: { t: TurnoverRow; property?: PropertyRow }) {
  const checkout = new Date(t.checkout_datetime)
  const isUrgent = t.priority === 'urgent' || t.priority === 'high'

  const fullAddress = [property?.address, property?.city, property?.state]
    .filter(Boolean).join(', ')

  return (
    <Link
      href={`/crew/turnovers/${t.id}`}
      className={cn(
        'block rounded-xl border p-3 mb-2 transition-shadow active:scale-[0.98]',
        'bg-card-themed',
        isUrgent ? 'border-amber-300' : 'border-themed'
      )}
    >
      <div className="flex items-start justify-between gap-1 mb-1.5">
        <p className="font-bold text-primary-themed text-sm leading-tight">
          {property?.name ?? 'Property'}
        </p>
        {isUrgent && <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />}
      </div>

      {fullAddress && (
        <div className="text-xs text-muted-themed flex items-center gap-1 mb-1.5">
          <MapPin className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{fullAddress}</span>
        </div>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={cn(
          'text-xs font-semibold px-2 py-0.5 rounded-full',
          t.status === 'assigned'    ? 'bg-blue-50 text-blue-700' :
          t.status === 'in_progress' ? 'bg-purple-50 text-purple-700' :
          'bg-raised-themed text-secondary-themed'
        )}>
          {t.status === 'assigned' ? 'Assigned' :
           t.status === 'in_progress' ? 'In Progress' : t.status}
        </span>
        <span className="text-xs text-secondary-themed">
          {checkout.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </span>
        {t.window_minutes && (
          <span className="text-xs text-muted-themed flex items-center gap-0.5">
            <Clock className="w-3 h-3" />
            {Math.floor(t.window_minutes / 60)}h
            {t.window_minutes % 60 > 0 ? ` ${t.window_minutes % 60}m` : ''}
          </span>
        )}
      </div>
    </Link>
  )
}

function WorkOrderCard({ wo, property }: { wo: CrewWorkOrderRow; property?: PropertyRow }) {
  const fullAddress = [property?.address, property?.city, property?.state]
    .filter(Boolean).join(', ')

  return (
    <Link
      href={`/crew/work-orders/${wo.id}`}
      className={cn(
        'block rounded-xl border p-3 mb-2 transition-shadow active:scale-[0.98]',
        'bg-amber-50 border-amber-200'
      )}
    >
      <div className="flex items-start justify-between gap-1 mb-1.5">
        <p className="font-bold text-primary-themed text-sm leading-tight">
          {wo.title}
        </p>
        <span className="text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full flex-shrink-0">
          WO
        </span>
      </div>
      {property?.name && (
        <p className="text-xs text-secondary-themed font-medium mb-1">{property.name}</p>
      )}
      {fullAddress && (
        <div className="text-xs text-muted-themed flex items-center gap-1 mb-1.5">
          <MapPin className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{fullAddress}</span>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className={cn(
          'text-xs font-semibold px-2 py-0.5 rounded-full',
          wo.status === 'assigned'    ? 'bg-blue-50 text-blue-700' :
          wo.status === 'in_progress' ? 'bg-purple-50 text-purple-700' :
          'bg-raised-themed text-secondary-themed'
        )}>
          {wo.status === 'assigned' ? 'Assigned' :
           wo.status === 'in_progress' ? 'In Progress' : wo.status}
        </span>
        {wo.scheduled_date && (
          <span className="text-xs text-muted-themed">
            Scheduled {new Date(wo.scheduled_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
    </Link>
  )
}

function EmptyColumn({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <p className="text-xs text-muted-themed">No {label.toLowerCase()}</p>
    </div>
  )
}

function CrewPageSkeleton() {
  return (
    <div className="flex flex-col min-h-full">
      <div className="px-4 py-3 mb-4" style={{ background: '#FCD116' }}>
        <div className="h-4 w-32 rounded bg-brand-900/20 animate-pulse" />
        <div className="h-3 w-48 rounded bg-brand-800/20 mt-2 animate-pulse" />
      </div>
      <div className="flex flex-1 gap-0">
        {[0, 1].map((col) => (
          <div key={col} className="flex-1 min-w-0 px-3">
            <div className="flex justify-center mb-3">
              <div className="h-6 w-32 rounded-full bg-raised-themed animate-pulse" />
            </div>
            {[0, 1].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-themed bg-card-themed p-3 mb-2 h-20 animate-pulse"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// Plain helper, not a component — keeps the Date.now()/new Date() calls out
// of the component's own body (react-hooks/purity flags impure calls
// anywhere lexically inside a component, including inside useMemo callbacks).
function todayAndWeekOutDates(): { today: string; weekOut: string } {
  return {
    today:   new Date().toISOString().split('T')[0]!,
    weekOut: new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0]!,
  }
}

const noopSubscribe = () => () => {}

export default function CrewDashboardPage() {
  // Only true after the client has mounted — gates hydration-sensitive UI
  // (local Dexie data isn't available during SSR).
  const isMounted = useSyncExternalStore(noopSubscribe, () => true, () => false)
  const [showFeedback, setShowFeedback] = useState(false)

  const { crewName } = useCrewContext()
  const firstName    = crewName.split(' ')[0] ?? crewName

  const { today, weekOut } = todayAndWeekOutDates()

  const db           = useDexieDb()
  const allTurnovers = useLiveQuery(
    () => db.turnovers
      .filter((t) =>
        t.checkout_datetime >= today + 'T00:00:00' &&
        t.checkout_datetime <= weekOut + 'T23:59:59' &&
        t.status !== 'completed' &&
        t.status !== 'cancelled'
      )
      .sortBy('checkout_datetime'),
    [today, weekOut]
  ) ?? EMPTY_ROWS

  const allWorkOrders = useLiveQuery(
    () => db.crew_work_orders
      .filter((wo) =>
        wo.status !== 'completed' &&
        wo.status !== 'cancelled'
      )
      .toArray(),
    []
  ) ?? EMPTY_ROWS

  const assignedPropertyIds = useMemo(
    () => new Set([
      ...(allTurnovers as TurnoverRow[]).map((t) => t.property_id),
      ...(allWorkOrders as CrewWorkOrderRow[]).map((wo) => wo.property_id),
    ]),
    [allTurnovers, allWorkOrders]
  )

  const propertiesArr = useLiveQuery(
    () => assignedPropertyIds.size > 0
      ? db.properties.where('id').anyOf([...assignedPropertyIds]).toArray()
      : Promise.resolve<PropertyRow[]>([]),
    [[...assignedPropertyIds].join(',')]   // stable dependency — Set identity changes every render
  ) ?? []

  const propertyMap = Object.fromEntries(propertiesArr.map((p) => [p.id, p]))

  const todayStr    = new Date().toDateString()
  const todayTurnovers    = (allTurnovers as TurnoverRow[]).filter(
    (t) => new Date(t.checkout_datetime).toDateString() === todayStr
  )
  const upcomingTurnovers = (allTurnovers as TurnoverRow[]).filter(
    (t) => new Date(t.checkout_datetime).toDateString() !== todayStr
  )

  // Work orders split by scheduled_date: today (or overdue) vs upcoming.
  // WOs with no scheduled date land at the bottom of the Upcoming column.
  const todayWorkOrders = (allWorkOrders as CrewWorkOrderRow[]).filter(
    (wo) => wo.scheduled_date != null && wo.scheduled_date <= today
  )
  const upcomingWorkOrders = (allWorkOrders as CrewWorkOrderRow[]).filter(
    (wo) => wo.scheduled_date == null || wo.scheduled_date > today
  )

  const travelSummary = calcTravelSummary(todayTurnovers, propertyMap as Record<string, PropertyRow>)

  if (!isMounted) return <CrewPageSkeleton />

  return (
    <div className="flex flex-col min-h-full">

      {/* ── Welcome banner ─────────────────────────────────────────────── */}
      <div
        className="px-4 py-3 mb-4"
        style={{ background: '#FCD116' }}
      >
        <p className="font-bold text-brand-900 text-base">
          Welcome, {firstName}
        </p>
        <p className="text-xs text-brand-800 mt-0.5">
          {allTurnovers.length + allWorkOrders.length === 0
            ? "You're all caught up — no active assignments."
            : `You have ${allTurnovers.length + allWorkOrders.length} active assignment${allTurnovers.length + allWorkOrders.length !== 1 ? 's' : ''}.`}
        </p>
      </div>

      {/* ── Two-column split ───────────────────────────────────────────── */}
      <div className="flex flex-1 gap-0">

        {/* Today column */}
        <div className="flex-1 min-w-0 px-3">
          {/* Section pill header */}
          <div className="flex justify-center mb-3">
            <span
              className="text-xs font-bold px-4 py-1.5 rounded-full text-white"
              style={{ background: '#0D1F3C' }}
            >
              Today&apos;s Turnovers
            </span>
          </div>
          {todayTurnovers.length > 0 && (
            <p className="text-xs text-center text-muted-themed mb-3">
              {travelSummary.available
                ? `Total Travel Time: ${travelSummary.miles.toFixed(1)} mi, ${Math.floor(travelSummary.minutes / 60)}:${String(travelSummary.minutes % 60).padStart(2, '0')}`
                : 'Total Travel Time: unavailable'}
            </p>
          )}
          {todayTurnovers.length === 0 && todayWorkOrders.length === 0
            ? <EmptyColumn label="Today's Turnovers" />
            : (
              <>
                {todayTurnovers.map((t) => (
                  <TurnoverCard
                    key={t.id}
                    t={t}
                    property={propertyMap[t.property_id]}
                  />
                ))}
                {todayWorkOrders.map((wo) => (
                  <WorkOrderCard
                    key={wo.id}
                    wo={wo}
                    property={propertyMap[wo.property_id]}
                  />
                ))}
              </>
            )
          }
        </div>

        {/* Vertical divider */}
        <div
          className="w-px flex-shrink-0 self-stretch"
          style={{ background: '#0D1F3C', opacity: 0.15 }}
        />

        {/* Upcoming column */}
        <div className="flex-1 min-w-0 px-3">
          {/* Section pill header */}
          <div className="flex justify-center mb-3">
            <span
              className="text-xs font-bold px-4 py-1.5 rounded-full text-white"
              style={{ background: '#0D1F3C' }}
            >
              Upcoming
            </span>
          </div>
          {upcomingTurnovers.length === 0 && upcomingWorkOrders.length === 0
            ? <EmptyColumn label="Upcoming" />
            : (
              <>
                {upcomingTurnovers.map((t) => (
                  <TurnoverCard
                    key={t.id}
                    t={t}
                    property={propertyMap[t.property_id]}
                  />
                ))}
                {upcomingWorkOrders.map((wo) => (
                  <WorkOrderCard
                    key={wo.id}
                    wo={wo}
                    property={propertyMap[wo.property_id]}
                  />
                ))}
              </>
            )
          }
        </div>
      </div>

      {/* ── Feedback entry point ────────────────────────────────────────── */}
      <div className="px-4 pt-6 pb-2 mt-2">
        <button
          onClick={() => setShowFeedback(true)}
          className="w-full py-2.5 rounded-xl text-xs font-semibold border border-themed text-secondary-themed hover:text-primary-themed hover:border-themed transition-colors flex items-center justify-center gap-1.5"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          Send feedback
        </button>
      </div>

      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </div>
  )
}

function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [text, setText]           = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  async function handleSubmit() {
    if (!text.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/crew/feedback', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ feedbackText: text.trim() }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? 'Something went wrong')
      }
      setText('')
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Close feedback modal"
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'flex-end',
      }}
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose() } }}
    >
      <div
        style={{
          background: '#fff', borderRadius: '16px 16px 0 0',
          padding: '24px 20px 40px', width: '100%', maxHeight: '85vh', overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: '#0D1F3C' }}>
            Send feedback
          </h2>
          <button onClick={onClose} style={{ fontSize: 20, color: '#94a3b8', padding: 4 }} aria-label="Close">
            ×
          </button>
        </div>

        {submitted ? (
          <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
            <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'center' }}><PartyPopper size={32} /></div>
            <p style={{ fontSize: 15, fontWeight: 700, color: '#0D1F3C', marginBottom: 4 }}>
              Thank you!
            </p>
            <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.6, marginBottom: 20 }}>
              Your feedback goes straight to the team that builds this app.
            </p>
            <button
              onClick={onClose}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white"
              style={{ background: '#0D1F3C' }}
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.6, marginBottom: 12 }}>
              What would make this app more helpful for your day-to-day work?
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder="Share an idea, a frustration, or anything that would help…"
              style={{
                width: '100%', borderRadius: 12, border: '1px solid #e2e8f0',
                padding: '12px', fontSize: 14, color: '#1e293b', resize: 'none',
                outline: 'none',
              }}
            />
            {error && (
              <p style={{ fontSize: 12, color: '#dc2626', marginTop: 8 }}>{error}</p>
            )}
            <button
              onClick={handleSubmit}
              disabled={submitting || !text.trim()}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white mt-4 disabled:opacity-50"
              style={{ background: '#0D1F3C' }}
            >
              {submitting ? 'Sending…' : 'Submit'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
