'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Clock, User, Wrench, Package, ChevronDown, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { NudgeBanner } from '@/components/nudge-banner'

// ── Types ──────────────────────────────────────────────────────

interface TurnoverAssignment {
  id:           string
  crew_member: { id: string; name: string } | { id: string; name: string }[] | null
}

interface Turnover {
  id:                   string
  property_id:          string
  checkout_datetime:    string
  checkin_datetime:     string
  window_minutes:       number | null
  status:               string
  priority:             string
  notes:                string | null
  turnover_assignments: TurnoverAssignment | TurnoverAssignment[] | null
}

interface Property    { id: string; name: string; city: string | null; state: string | null }
interface WorkOrder   { id: string; title: string; property_id: string; priority: string; status: string; scheduled_date: string | null }
interface LowStockItem { id: string; name: string; property_id: string; current_quantity: number; par_level: number }

interface KPIs {
  turnoversToday:   number
  todayAssigned:    number
  todayUnassigned:  number
  unassigned:       number
  openWorkOrders:   number
  urgentWorkOrders: number
  belowPar:         number
}

interface Metrics {
  occupancyRate:     number
  confirmedBookings: number
  turnoversCompleted: number
}

// ── KPI Card ───────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  accentColor = 'var(--accent-gold)',
  alert = false,
  href,
  breakdown,
}: {
  label:        string
  value:        number
  accentColor?: string
  alert?:       boolean
  href?:        string
  breakdown?:   React.ReactNode
}) {
  const inner = (
    <div
      className={cn('kpi-card', href && 'cursor-pointer hover:shadow-md hover:border-[var(--accent-gold)] transition-colors')}
      style={{ '--kpi-accent': accentColor } as React.CSSProperties}
    >
      <div className="kpi-value" style={alert && value > 0 ? { color: accentColor } : undefined}>
        {value}
      </div>
      <div className="kpi-label mt-1">{label}</div>
      {breakdown && (
        <div className="mt-1.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
          {breakdown}
        </div>
      )}
    </div>
  )

  return href ? <Link href={href}>{inner}</Link> : inner
}

// ── Mobile Exception Banner (shows above KPIs on small screens only) ──────────

function MobileExceptionBanner({
  urgentWorkOrders,
  overdueCount,
  belowPar,
}: {
  urgentWorkOrders: number
  overdueCount:     number
  belowPar:         number
}) {
  const hasExceptions = urgentWorkOrders > 0 || overdueCount > 0 || belowPar > 0
  if (!hasExceptions) return null

  return (
    <div className="md:hidden space-y-2 mb-5">
      <p className="text-xs font-semibold uppercase tracking-wide"
         style={{ color: 'var(--text-muted)' }}>
        Needs Attention
      </p>

      {urgentWorkOrders > 0 && (
        <Link href="/maintenance?filter=urgent">
          <div className="flex items-center gap-3 rounded-xl px-4 py-3"
               style={{ background: 'var(--accent-red-dim)', border: '1px solid var(--accent-red)' }}>
            <Wrench className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-red)' }} />
            <p className="text-sm font-semibold flex-1" style={{ color: 'var(--accent-red)' }}>
              {urgentWorkOrders} urgent work order{urgentWorkOrders !== 1 ? 's' : ''}
            </p>
            <ChevronRight className="w-4 h-4" style={{ color: 'var(--accent-red)' }} />
          </div>
        </Link>
      )}

      {overdueCount > 0 && (
        <Link href="/turnovers?status=pending_assignment">
          <div className="flex items-center gap-3 rounded-xl px-4 py-3"
               style={{ background: 'var(--accent-amber-dim)', border: '1px solid var(--accent-amber)' }}>
            <Clock className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-amber)' }} />
            <p className="text-sm font-semibold flex-1" style={{ color: 'var(--accent-amber)' }}>
              {overdueCount} turnover{overdueCount !== 1 ? 's' : ''} unassigned
            </p>
            <ChevronRight className="w-4 h-4" style={{ color: 'var(--accent-amber)' }} />
          </div>
        </Link>
      )}

      {belowPar > 0 && (
        <Link href="/inventory?filter=below_par">
          <div className="flex items-center gap-3 rounded-xl px-4 py-3"
               style={{ background: 'var(--accent-blue-dim)', border: '1px solid var(--accent-blue)' }}>
            <Package className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-blue)' }} />
            <p className="text-sm font-semibold flex-1" style={{ color: 'var(--accent-blue)' }}>
              {belowPar} item{belowPar !== 1 ? 's' : ''} below par
            </p>
            <ChevronRight className="w-4 h-4" style={{ color: 'var(--accent-blue)' }} />
          </div>
        </Link>
      )}
    </div>
  )
}

// ── Turnover Card ──────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending_assignment: 'var(--text-muted)',
  assigned:           'var(--accent-blue)',
  in_progress:        '#a78bfa',
  completed:          'var(--accent-green)',
  flagged:            'var(--accent-red)',
}

function TurnoverCard({
  turnover,
  propertyName,
}: {
  turnover:     Turnover
  propertyName: string
}) {
  const assignments = Array.isArray(turnover.turnover_assignments)
    ? turnover.turnover_assignments
    : turnover.turnover_assignments
      ? [turnover.turnover_assignments]
      : []

  const crew = assignments.flatMap((a) => {
    const cm = a.crew_member
    return cm ? (Array.isArray(cm) ? cm : [cm]) : []
  })

  const statusColor = STATUS_COLORS[turnover.status] ?? 'var(--text-muted)'
  const isUrgent    = turnover.priority === 'urgent' || turnover.priority === 'high'
  const checkout    = new Date(turnover.checkout_datetime)

  return (
    <Link href={`/turnovers/${turnover.id}`}>
      <div
        className="rounded-xl p-4 mb-2.5 transition-all cursor-pointer"
        style={{
          background:  'var(--bg-card)',
          border:      '1px solid var(--border)',
          borderLeft:  `3px solid ${statusColor}`,
        }}
        onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-raised)' }}
        onMouseOut={(e)  => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)'   }}
      >
        <p className="font-semibold text-sm mb-1.5 truncate"
           style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-syne)' }}>
          {propertyName}
        </p>

        <div className="flex items-center gap-1.5 text-xs mb-2"
             style={{ color: 'var(--text-muted)' }}>
          <Clock className="w-3 h-3 flex-shrink-0" />
          <span>
            {checkout.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
          {turnover.window_minutes && (
            <>
              <span>·</span>
              <span>{Math.floor(turnover.window_minutes / 60)}h window</span>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs">
            <User className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <span style={{
              color:      crew.length > 0 ? 'var(--text-secondary)' : 'var(--accent-amber)',
              fontWeight: crew.length === 0 ? 600 : 400,
            }}>
              {crew.length > 0 ? crew.map((c) => c.name).join(', ') : 'Unassigned'}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {isUrgent && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ background: 'var(--accent-amber-dim)', color: 'var(--accent-amber)' }}
              >
                Urgent
              </span>
            )}
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{ background: `${statusColor}20`, color: statusColor }}
            >
              {turnover.status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
            </span>
          </div>
        </div>
      </div>
    </Link>
  )
}

// ── Day Accordion ──────────────────────────────────────────────

function DayAccordion({
  label,
  isToday,
  turnovers,
  propertyMap,
  defaultOpen,
}: {
  label:       string
  isToday:     boolean
  turnovers:   Turnover[]
  propertyMap: Record<string, string>
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const hasAlert = turnovers.some(
    t => t.status === 'pending_assignment' || t.priority === 'urgent'
  )

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ border: isToday ? '1px solid var(--accent-gold)' : '1px solid var(--border)' }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 transition-colors"
        style={{ background: isToday ? 'var(--bg-raised)' : 'var(--bg-card)' }}
      >
        <span
          className="font-semibold text-sm"
          style={{ color: isToday ? 'var(--accent-gold)' : 'var(--text-secondary)' }}
        >
          {label}
        </span>
        <div className="flex items-center gap-2">
          {turnovers.length > 0 ? (
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{
                background: hasAlert ? 'var(--accent-amber-dim)' : 'var(--border)',
                color:      hasAlert ? 'var(--accent-amber)'     : 'var(--text-muted)',
              }}
            >
              {turnovers.length}
            </span>
          ) : (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Clear
            </span>
          )}
          <ChevronDown
            className={cn('w-4 h-4 transition-transform', open && 'rotate-180')}
            style={{ color: 'var(--text-muted)' }}
          />
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1" style={{ background: 'var(--bg-canvas)' }}>
          {turnovers.length === 0 ? (
            <p className="text-sm text-center py-4" style={{ color: 'var(--text-muted)' }}>
              No turnovers
            </p>
          ) : (
            turnovers.map(t => (
              <TurnoverCard
                key={t.id}
                turnover={t}
                propertyName={propertyMap[t.property_id] ?? 'Unknown'}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function getDayLabel(day: string, todayDate: string): string {
  const yesterday = new Date(todayDate + 'T12:00:00')
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayIso = yesterday.toISOString().split('T')[0]!
  if (day === todayDate)    return 'Today'
  if (day === yesterdayIso) return 'Yesterday'
  return new Date(day + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  })
}

// ── Main Component ─────────────────────────────────────────────

export function OpsSnapshot({
  turnovers,
  properties,
  openWorkOrders,
  lowStockItems,
  kpis,
  todayDate,
  metrics,
  showOwnerRezNudge = false,
}: {
  turnovers:      Turnover[]
  properties:     Property[]
  openWorkOrders: WorkOrder[]
  lowStockItems:  LowStockItem[]
  kpis:           KPIs
  todayDate:      string
  metrics?:       Metrics
  showOwnerRezNudge?: boolean
}) {
  const [windowDays, setWindowDays] = useState<7 | 14 | 30>(7)

  const propertyMap = Object.fromEntries(properties.map((p) => [p.id, p.name]))

  const days = Array.from({ length: windowDays + 1 }, (_, i) => {
    const d = new Date(todayDate + 'T12:00:00')
    d.setDate(d.getDate() + i - 1)
    return d.toISOString().split('T')[0]!
  })

  const byDay = Object.fromEntries(
    days.map((day) => [
      day,
      turnovers.filter((t) => t.checkout_datetime.startsWith(day)),
    ])
  )

  return (
    <div>
      {showOwnerRezNudge && (
        <NudgeBanner
          id="ownerrez-revenue-intro"
          message="Booking revenue and cleaning fees post to owner ledgers automatically when you connect OwnerRez."
          href="/settings?tab=integrations"
          linkText="Connect OwnerRez"
        />
      )}

      {/* Page header */}
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Ops Snapshot</h1>
          <p className="page-subtitle">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long', month: 'long', day: 'numeric',
            })}
          </p>
        </div>
        <Link href="/turnovers" className="btn-secondary text-xs gap-1.5">
          Full board <ChevronDown className="w-3.5 h-3.5 -rotate-90" />
        </Link>
      </div>

      {/* Window selector */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Showing
        </span>
        <div className="flex items-center gap-1 rounded-lg px-1 py-1"
             style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          {([7, 14, 30] as const).map((d) => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-md transition-colors',
                windowDays !== d && 'text-muted-themed hover:text-secondary-themed'
              )}
              style={windowDays === d ? {
                background: 'var(--bg-raised)',
                boxShadow:  'inset 0 0 0 1px var(--accent-gold)',
                color:      'var(--accent-gold)',
              } : undefined}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Mobile exception banner — visible only below md breakpoint */}
      <MobileExceptionBanner
        urgentWorkOrders={kpis.urgentWorkOrders}
        overdueCount={kpis.unassigned}
        belowPar={kpis.belowPar}
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <KpiCard
          label="Turnovers Today"
          value={kpis.turnoversToday}
          accentColor="var(--accent-gold)"
          href="/turnovers"
          breakdown={
            kpis.turnoversToday === 0 ? 'No turnovers today' :
            kpis.todayUnassigned > 0 ? (
              <span>
                <span style={{ color: 'var(--accent-green)' }}>{kpis.todayAssigned} assigned</span>
                {' · '}
                <span style={{ color: 'var(--accent-amber)', fontWeight: 600 }}>
                  🔴 {kpis.todayUnassigned} unassigned
                </span>
              </span>
            ) : `All ${kpis.turnoversToday} assigned ✓`
          }
        />
        <KpiCard
          label="Unassigned"
          value={kpis.unassigned}
          accentColor="var(--accent-amber)"
          alert
          href="/turnovers?status=pending_assignment"
          breakdown={kpis.unassigned > 0 ? 'Tap to assign crew' : undefined}
        />
        <KpiCard
          label="Open Work Orders"
          value={kpis.openWorkOrders}
          accentColor="var(--accent-blue)"
          alert
          href="/maintenance?filter=urgent"
          breakdown={
            kpis.urgentWorkOrders > 0
              ? <span style={{ color: 'var(--accent-red)' }}>{kpis.urgentWorkOrders} urgent / high</span>
              : undefined
          }
        />
        <KpiCard
          label="Below Par"
          value={kpis.belowPar}
          accentColor="var(--accent-red)"
          alert
          href="/inventory?filter=below_par"
          breakdown={kpis.belowPar > 0 ? 'Tap to view inventory' : undefined}
        />
      </div>

      {/* This Month metrics */}
      {metrics && (
        <div
          className="rounded-xl p-4 mb-6"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <p
            className="text-xs font-semibold uppercase tracking-wide mb-3"
            style={{ color: 'var(--text-muted)' }}
          >
            {new Date().toLocaleDateString('en-US', { month: 'long' })} at a glance
          </p>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                {metrics.occupancyRate}%
              </div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Portfolio Occupancy
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                {metrics.confirmedBookings}
              </div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Confirmed Bookings
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                {metrics.turnoversCompleted}
              </div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Turnovers Completed
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Accordion list */}
      <div className="space-y-2">
        {days.map((day) => {
          const dayTurnovers = byDay[day] ?? []
          const isToday      = day === todayDate
          const hasUrgent    = dayTurnovers.some(t =>
            t.priority === 'urgent' || t.status === 'pending_assignment'
          )
          return (
            <DayAccordion
              key={day}
              label={getDayLabel(day, todayDate)}
              isToday={isToday}
              turnovers={dayTurnovers}
              propertyMap={propertyMap}
              defaultOpen={isToday || hasUrgent}
            />
          )
        })}
      </div>

      {/* Bottom panels: Work orders + Low stock */}
      {(openWorkOrders.length > 0 || lowStockItems.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-8">

          {openWorkOrders.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="section-header mb-0">Open Work Orders</p>
                <Link href="/maintenance" className="text-xs" style={{ color: 'var(--accent-gold)' }}>
                  View all →
                </Link>
              </div>
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                {openWorkOrders.slice(0, 5).map((wo, i) => (
                  <Link key={wo.id} href={`/maintenance/${wo.id}`}>
                    <div
                      className={cn('flex items-center gap-3 px-4 py-3 transition-colors', i > 0 && 'border-t')}
                      style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
                      onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-raised)' }}
                      onMouseOut={(e)  => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)'   }}
                    >
                      <Wrench className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-blue)' }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{wo.title}</p>
                        <p className="text-xs"          style={{ color: 'var(--text-muted)'   }}>{propertyMap[wo.property_id] ?? ''}</p>
                      </div>
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                        style={{
                          background: wo.priority === 'urgent' || wo.priority === 'high'
                            ? 'var(--accent-red-dim)'
                            : 'var(--accent-amber-dim)',
                          color: wo.priority === 'urgent' || wo.priority === 'high'
                            ? 'var(--accent-red)'
                            : 'var(--accent-amber)',
                        }}
                      >
                        {wo.priority}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {lowStockItems.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="section-header mb-0">Below Par</p>
                <Link href="/inventory" className="text-xs" style={{ color: 'var(--accent-gold)' }}>
                  View all →
                </Link>
              </div>
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                {lowStockItems.slice(0, 5).map((item, i) => (
                  <div
                    key={item.id}
                    className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t')}
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
                  >
                    <Package className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-red)' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{item.name}</p>
                      <p className="text-xs"          style={{ color: 'var(--text-muted)'   }}>{propertyMap[item.property_id] ?? ''}</p>
                    </div>
                    <span className="text-xs font-semibold" style={{ color: 'var(--accent-red)' }}>
                      {item.current_quantity}/{item.par_level}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
