'use client'

import { useEffect, useState }           from 'react'
import { useLiveQuery }   from 'dexie-react-hooks'
import { useDexieDb }     from '@/lib/dexie/context'

import Link                              from 'next/link'
import { AlertCircle, MapPin, Clock }    from 'lucide-react'
import { cn }                            from '@/lib/utils'
import { useCrewContext }                from '@/lib/crew/crew-context'
import { distanceMiles }                 from '@/lib/geocoding'

const AVG_DRIVE_SPEED_MPH = 30

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
        'bg-white',
        isUrgent ? 'border-amber-300' : 'border-accent-200'
      )}
    >
      <div className="flex items-start justify-between gap-1 mb-1.5">
        <p className="font-bold text-accent-900 text-sm leading-tight">
          {property?.name ?? 'Property'}
        </p>
        {isUrgent && <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />}
      </div>

      {fullAddress && (
        <div className="text-xs text-accent-500 flex items-center gap-1 mb-1.5">
          <MapPin className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{fullAddress}</span>
        </div>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={cn(
          'text-xs font-semibold px-2 py-0.5 rounded-full',
          t.status === 'assigned'    ? 'bg-blue-50 text-blue-700' :
          t.status === 'in_progress' ? 'bg-purple-50 text-purple-700' :
          'bg-accent-100 text-accent-600'
        )}>
          {t.status === 'assigned' ? 'Assigned' :
           t.status === 'in_progress' ? 'In Progress' : t.status}
        </span>
        <span className="text-xs text-accent-600">
          {checkout.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </span>
        {t.window_minutes && (
          <span className="text-xs text-accent-500 flex items-center gap-0.5">
            <Clock className="w-3 h-3" />
            {Math.floor(t.window_minutes / 60)}h
            {t.window_minutes % 60 > 0 ? ` ${t.window_minutes % 60}m` : ''}
          </span>
        )}
      </div>
    </Link>
  )
}

function EmptyColumn({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <p className="text-xs text-accent-400">No {label.toLowerCase()}</p>
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
              <div className="h-6 w-32 rounded-full bg-accent-100 animate-pulse" />
            </div>
            {[0, 1].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-accent-200 bg-white p-3 mb-2 h-20 animate-pulse"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function CrewDashboardPage() {
  const [isMounted, setIsMounted] = useState(false)
  useEffect(() => {
    setIsMounted(true)
  }, [])

  const { crewName } = useCrewContext()
  const firstName    = crewName.split(' ')[0] ?? crewName

  const today   = new Date().toISOString().split('T')[0]!
  const weekOut = new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0]!

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
  ) ?? []
  const propertiesArr = useLiveQuery(() => db.properties.toArray()) ?? []

  const propertyMap = Object.fromEntries(propertiesArr.map((p) => [p.id, p]))

  const todayStr    = new Date().toDateString()
  const todayTurnovers    = (allTurnovers as TurnoverRow[]).filter(
    (t) => new Date(t.checkout_datetime).toDateString() === todayStr
  )
  const upcomingTurnovers = (allTurnovers as TurnoverRow[]).filter(
    (t) => new Date(t.checkout_datetime).toDateString() !== todayStr
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
          {allTurnovers.length === 0
            ? "You're all caught up — no active assignments."
            : `You have ${allTurnovers.length} active assignment${allTurnovers.length !== 1 ? 's' : ''}.`}
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
              Today's Turnovers
            </span>
          </div>
          {todayTurnovers.length > 0 && (
            <p className="text-xs text-center text-accent-500 mb-3">
              {travelSummary.available
                ? `Total Travel Time: ${travelSummary.miles.toFixed(1)} mi, ${Math.floor(travelSummary.minutes / 60)}:${String(travelSummary.minutes % 60).padStart(2, '0')}`
                : 'Total Travel Time: unavailable'}
            </p>
          )}
          {todayTurnovers.length === 0
            ? <EmptyColumn label="Today's Turnovers" />
            : todayTurnovers.map((t) => (
                <TurnoverCard
                  key={t.id}
                  t={t}
                  property={propertyMap[t.property_id]}
                />
              ))
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
          {upcomingTurnovers.length === 0
            ? <EmptyColumn label="Upcoming" />
            : upcomingTurnovers.map((t) => (
                <TurnoverCard
                  key={t.id}
                  t={t}
                  property={propertyMap[t.property_id]}
                />
              ))
          }
        </div>
      </div>
    </div>
  )
}
