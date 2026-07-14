import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { OpsSnapshot } from './ops-snapshot'
import { addDays, subDays, startOfDay, endOfDay } from 'date-fns'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Ops Snapshot' }

export default async function OpsSnapshotPage() {
  const { supabase, membership } = await requireOrgMember()

  const today      = new Date()
  const rangeStart = startOfDay(subDays(today, 1))
  const rangeEnd   = endOfDay(addDays(today, 29))
  const todayIso   = today.toISOString().split('T')[0]!

  const [
    { data: turnovers },
    { data: properties },
    { data: openWOs },
    { data: inventoryItems },
  ] = await Promise.all([
    supabase
      .from('turnovers')
      .select(`
        id, property_id, checkout_datetime, checkin_datetime,
        window_minutes, status, priority, notes, completed_at, started_at,
        checklist_template_id,
        turnover_assignments(id, crew_member_id, crew_member:crew_members(id, name))
      `)
      .eq('org_id', membership.org_id)
      .neq('status', 'cancelled')
      .gte('checkout_datetime', rangeStart.toISOString())
      .lte('checkout_datetime', rangeEnd.toISOString())
      .order('checkout_datetime', { ascending: true }),

    supabase
      .from('properties')
      .select('id, name, city, state, lat, lng')
      .eq('org_id', membership.org_id)
      .eq('is_active', true),

    supabase
      .from('work_orders')
      .select('id, title, property_id, priority, status, scheduled_date')
      .eq('org_id', membership.org_id)
      .in('status', ['pending', 'assigned', 'in_progress'])
      .order('scheduled_date', { ascending: true })
      .limit(8),

    supabase
      .from('inventory_items')
      .select('id, name, property_id, current_quantity, par_level, first_count_recorded_at')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .limit(200),
  ])

  // Occupancy for current month
  const monthStart  = new Date(today.getFullYear(), today.getMonth(), 1)
  const monthEnd    = new Date(today.getFullYear(), today.getMonth() + 1, 0)
  const monthStartIso = monthStart.toISOString().split('T')[0]!
  const monthEndIso   = monthEnd.toISOString().split('T')[0]!

  const { data: monthBookings } = await supabase
    .from('bookings')
    .select('id, property_id, checkin_date, checkout_date, status')
    .eq('org_id', membership.org_id)
    .eq('status', 'confirmed')
    .gte('checkout_date', monthStartIso)
    .lte('checkin_date',  monthEndIso)

  const lowStockItems = (inventoryItems ?? []).filter(
    (i) => i.first_count_recorded_at && i.current_quantity <= i.par_level
  )

  // Providers whose sync actually fires booking/confirmed (see
  // lib/inngest/functions/booking-events.ts) — i.e. the ones the automation
  // this nudge advertises actually works for. Hostaway/Guesty connections
  // don't post revenue automatically yet, so connecting one of those
  // shouldn't suppress the nudge.
  const REVENUE_AUTOMATION_PROVIDER_IDS = ['ownerrez', 'hospitable']

  const admin = createServiceClient()
  const { data: pmsConnections } = await admin
    .from('integration_connections')
    .select('id')
    .eq('org_id', membership.org_id)
    .in('provider_id', REVENUE_AUTOMATION_PROVIDER_IDS)
    .eq('status', 'active')

  const showPmsRevenueNudge = !pmsConnections?.length

  const allTurnovers   = turnovers ?? []
  const openWorkOrders = openWOs ?? []

  const todayTurnovers  = allTurnovers.filter(t => t.checkout_datetime.startsWith(todayIso))
  const todayAssigned   = todayTurnovers.filter(t => t.status !== 'pending_assignment').length
  const todayUnassigned = todayTurnovers.filter(t => t.status === 'pending_assignment').length

  const allActiveUnassigned = allTurnovers.filter(t => t.status === 'pending_assignment').length

  const urgentWorkOrders = openWorkOrders.filter(
    w => w.priority === 'urgent' || w.priority === 'high'
  ).length

  // Occupancy computation
  const daysInMonth    = monthEnd.getDate()
  const propCount      = (properties ?? []).length
  const totalNights    = propCount * daysInMonth
  const occupiedNights = (monthBookings ?? []).reduce((sum, b) => {
    const cin  = new Date(Math.max(new Date(b.checkin_date).getTime(),  monthStart.getTime()))
    const cout = new Date(Math.min(new Date(b.checkout_date).getTime(), monthEnd.getTime()))
    return sum + Math.max(0, Math.ceil((cout.getTime() - cin.getTime()) / 86_400_000))
  }, 0)
  const occupancyRate      = totalNights > 0 ? Math.round((occupiedNights / totalNights) * 100) : 0
  const confirmedBookings  = (monthBookings ?? []).length
  const turnoversCompleted = allTurnovers.filter(t => t.status === 'completed').length

  return (
    <OpsSnapshot
      turnovers={allTurnovers}
      properties={properties ?? []}
      openWorkOrders={openWorkOrders}
      lowStockItems={lowStockItems}
      todayDate={todayIso}
      kpis={{
        turnoversToday:   todayTurnovers.length,
        todayAssigned,
        todayUnassigned,
        unassigned:       allActiveUnassigned,
        openWorkOrders:   openWorkOrders.length,
        urgentWorkOrders,
        belowPar:         lowStockItems.length,
      }}
      metrics={{ occupancyRate, confirmedBookings, turnoversCompleted }}
      showPmsRevenueNudge={showPmsRevenueNudge}
    />
  )
}
