import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrapList, type PostgrestResult } from '@/lib/supabase/unwrap'
import { OpsSnapshot } from './ops-snapshot'
import { addDays, subDays, startOfDay, endOfDay } from 'date-fns'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Ops Snapshot' }

// Shape returned by the inventory_below_par_for_org RPC. RPC return types are
// not modelled in types/database.ts (Functions is Record<string, never>), so
// the row shape is declared at the call site and kept in step with migration
// 20260730610000.
interface BelowParRow {
  id:                      string
  name:                    string
  property_id:             string
  current_quantity:        number
  par_level:               number
  first_count_recorded_at: string | null
}

export default async function OpsSnapshotPage() {
  const { supabase, membership } = await requireOrgMember()

  const today      = new Date()
  const rangeStart = startOfDay(subDays(today, 1))
  const rangeEnd   = endOfDay(addDays(today, 29))
  const todayIso   = today.toISOString().split('T')[0]!

  // Occupancy window for the current month.
  const monthStart  = new Date(today.getFullYear(), today.getMonth(), 1)
  const monthEnd    = new Date(today.getFullYear(), today.getMonth() + 1, 0)
  const monthStartIso = monthStart.toISOString().split('T')[0]!
  const monthEndIso   = monthEnd.toISOString().split('T')[0]!

  // Providers whose sync actually fires booking/confirmed (see
  // lib/inngest/functions/booking-events.ts) — i.e. the ones the automation
  // this nudge advertises actually works for. Hostaway/Guesty connections
  // don't post revenue automatically yet, so connecting one of those
  // shouldn't suppress the nudge.
  const REVENUE_AUTOMATION_PROVIDER_IDS = ['ownerrez', 'hospitable']
  const admin = createServiceClient({ authorizedBy: membership })

  // All six reads are independent — the bookings and integration_connections
  // queries used to be awaited sequentially after this block, adding two full
  // round trips to every render of the main dashboard for no reason.
  const [
    turnoversRes,
    propertiesRes,
    openWOsRes,
    belowParRes,
    monthBookingsRes,
    pmsConnectionsRes,
  ] = await Promise.all([
    supabase
      .from('turnovers')
      .select(`
        id, property_id, prev_booking_id, checkout_datetime, checkin_datetime,
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

    // The below-par KPI used to be .limit(200) with no .order(), filtered in
    // JS — an arbitrary 200-row sample, so a 50-property org saw a
    // meaningless number on its main dashboard. The comparison is
    // column-to-column, which the JS client can't express, so it happens in
    // SQL. SECURITY INVOKER: RLS still applies (migration 20260730610000).
    supabase.rpc('inventory_below_par_for_org', { p_org_id: membership.org_id }),

    supabase
      .from('bookings')
      .select('id, property_id, checkin_date, checkout_date, status')
      .eq('org_id', membership.org_id)
      .eq('status', 'confirmed')
      .gte('checkout_date', monthStartIso)
      .lte('checkin_date',  monthEndIso),

    admin
      .from('integration_connections')
      .select('id')
      .eq('org_id', membership.org_id)
      .in('provider_id', REVENUE_AUTOMATION_PROVIDER_IDS)
      .eq('status', 'active')
      .limit(REVENUE_AUTOMATION_PROVIDER_IDS.length),
  ])

  // unwrapList logs + reports and throws, so a failed read renders
  // app/(dashboard)/ops/error.tsx — a real error state, not a dashboard of
  // reassuring zeroes.
  const ctx = { site: 'page.ops', orgId: membership.org_id }
  const allTurnovers   = unwrapList(turnoversRes,      { ...ctx, extra: { query: 'turnovers' } })
  const properties     = unwrapList(propertiesRes,     { ...ctx, extra: { query: 'properties' } })
  const openWorkOrders = unwrapList(openWOsRes,        { ...ctx, extra: { query: 'work_orders' } })
  const lowStockItems  = unwrapList(belowParRes as PostgrestResult<BelowParRow[]>, { ...ctx, extra: { query: 'below_par' } })
  const monthBookings  = unwrapList(monthBookingsRes,  { ...ctx, extra: { query: 'bookings' } })
  const pmsConnections = unwrapList(pmsConnectionsRes, { ...ctx, extra: { query: 'integration_connections' } })

  const showPmsRevenueNudge = pmsConnections.length === 0

  const todayTurnovers  = allTurnovers.filter(t => t.checkout_datetime.startsWith(todayIso))
  const todayAssigned   = todayTurnovers.filter(t => t.status !== 'pending_assignment').length
  const todayUnassigned = todayTurnovers.filter(t => t.status === 'pending_assignment').length

  const allActiveUnassigned = allTurnovers.filter(t => t.status === 'pending_assignment').length

  const urgentWorkOrders = openWorkOrders.filter(
    w => w.priority === 'urgent' || w.priority === 'high'
  ).length

  // Occupancy computation
  const daysInMonth    = monthEnd.getDate()
  const propCount      = properties.length
  const totalNights    = propCount * daysInMonth
  const occupiedNights = monthBookings.reduce((sum, b) => {
    const cin  = new Date(Math.max(new Date(b.checkin_date).getTime(),  monthStart.getTime()))
    const cout = new Date(Math.min(new Date(b.checkout_date).getTime(), monthEnd.getTime()))
    return sum + Math.max(0, Math.ceil((cout.getTime() - cin.getTime()) / 86_400_000))
  }, 0)
  const occupancyRate      = totalNights > 0 ? Math.round((occupiedNights / totalNights) * 100) : 0
  const confirmedBookings  = monthBookings.length
  const turnoversCompleted = allTurnovers.filter(t => t.status === 'completed').length

  return (
    <OpsSnapshot
      turnovers={allTurnovers}
      properties={properties}
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
