'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Clock, User, Wrench, Package, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────

interface TurnoverAssignment {
  id:           string
  crew_members: { id: string; name: string } | { id: string; name: string }[] | null
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
  turnoversToday: number
  unassigned:     number
  openWorkOrders: number
  belowPar:       number
}

// ── KPI Card ───────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  accentColor = 'var(--accent-gold)',
  alert = false,
}: {
  label:        string
  value:        number
  accentColor?: string
  alert?:       boolean
}) {
  return (
    <div
      className="kpi-card"
      style={{ '--kpi-accent': accentColor } as React.CSSProperties}
    >
      <div className="kpi-value" style={alert && value > 0 ? { color: accentColor } : undefined}>
        {value}
      </div>
      <div className="kpi-label mt-2">{label}</div>
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
    const cm = a.crew_members
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
          borderLeft:  isUrgent
            ? '3px solid var(--accent-amber)'
            : `3px solid ${statusColor}`,
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

          <span
            className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ background: `${statusColor}20`, color: statusColor }}
          >
            {turnover.status.replace('_', ' ')}
          </span>
        </div>
      </div>
    </Link>
  )
}

// ── Day Column ─────────────────────────────────────────────────

function DayColumn({
  label,
  isToday,
  turnovers,
  propertyMap,
}: {
  label:       string
  isToday:     boolean
  turnovers:   Turnover[]
  propertyMap: Record<string, string>
}) {
  return (
    <div className="flex flex-col min-w-0">
      <div
        className="flex items-center justify-between px-4 py-3 rounded-xl mb-3"
        style={{
          background: isToday ? 'var(--bg-raised)' : 'var(--border)',
          border:     isToday ? '1px solid var(--accent-gold)' : '1px solid transparent',
        }}
      >
        <span
          className="font-display font-bold text-sm"
          style={{ color: isToday ? 'var(--accent-gold)' : 'var(--text-secondary)' }}
        >
          {label}
        </span>
        <span
          className="text-xs font-semibold px-2 py-0.5 rounded-full"
          style={{
            background: isToday ? 'var(--accent-gold-dim)' : 'var(--border)',
            color:      isToday ? 'var(--accent-gold)'     : 'var(--text-muted)',
          }}
        >
          {turnovers.length}
        </span>
      </div>

      <div className="flex-1">
        {turnovers.length === 0 ? (
          <div
            className="rounded-xl p-6 text-center text-sm"
            style={{
              background: 'var(--bg-card)',
              border:     '1px solid var(--border)',
              color:      'var(--text-muted)',
            }}
          >
            No turnovers
          </div>
        ) : (
          turnovers.map((t) => (
            <TurnoverCard
              key={t.id}
              turnover={t}
              propertyName={propertyMap[t.property_id] ?? 'Unknown property'}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────

export function OpsSnapshot({
  turnovers,
  properties,
  openWorkOrders,
  lowStockItems,
  kpis,
  dates,
}: {
  turnovers:      Turnover[]
  properties:     Property[]
  openWorkOrders: WorkOrder[]
  lowStockItems:  LowStockItem[]
  kpis:           KPIs
  dates:          { yesterday: string; today: string; tomorrow: string }
}) {
  const [mobileDay, setMobileDay] = useState<'yesterday' | 'today' | 'tomorrow'>('today')

  const propertyMap = Object.fromEntries(properties.map((p) => [p.id, p.name]))

  const byDay = {
    yesterday: turnovers.filter((t) => t.checkout_datetime.startsWith(dates.yesterday)),
    today:     turnovers.filter((t) => t.checkout_datetime.startsWith(dates.today)),
    tomorrow:  turnovers.filter((t) => t.checkout_datetime.startsWith(dates.tomorrow)),
  }

  const dayLabels = { yesterday: 'Yesterday', today: 'Today', tomorrow: 'Tomorrow' }

  return (
    <div>
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
          Full board <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <KpiCard label="Turnovers Today"  value={kpis.turnoversToday} accentColor="var(--accent-gold)" />
        <KpiCard label="Unassigned"       value={kpis.unassigned}     accentColor="var(--accent-amber)" alert />
        <KpiCard label="Open Work Orders" value={kpis.openWorkOrders} accentColor="var(--accent-blue)"  alert />
        <KpiCard label="Below Par"        value={kpis.belowPar}       accentColor="var(--accent-red)"   alert />
      </div>

      {/* Desktop: 3-column layout */}
      <div className="hidden md:grid grid-cols-3 gap-5">
        {(['yesterday', 'today', 'tomorrow'] as const).map((day) => (
          <DayColumn
            key={day}
            label={dayLabels[day]}
            isToday={day === 'today'}
            turnovers={byDay[day]}
            propertyMap={propertyMap}
          />
        ))}
      </div>

      {/* Mobile: tab switcher + single column */}
      <div className="md:hidden">
        <div
          className="flex rounded-xl p-1 mb-4 gap-1"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          {(['yesterday', 'today', 'tomorrow'] as const).map((day) => (
            <button
              key={day}
              onClick={() => setMobileDay(day)}
              className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
              style={{
                background: mobileDay === day ? 'var(--bg-raised)' : 'transparent',
                color:      mobileDay === day ? 'var(--accent-gold)' : 'var(--text-muted)',
                border:     mobileDay === day ? '1px solid var(--border-strong)' : '1px solid transparent',
              }}
            >
              {dayLabels[day]}
              <span className="ml-1.5 text-xs opacity-70">({byDay[day].length})</span>
            </button>
          ))}
        </div>

        <DayColumn
          label={dayLabels[mobileDay]}
          isToday={mobileDay === 'today'}
          turnovers={byDay[mobileDay]}
          propertyMap={propertyMap}
        />
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
