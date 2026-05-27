import { requireOrgMember } from '@/lib/auth'
import { OpsSnapshot } from './ops-snapshot'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Ops Snapshot' }

export default async function OpsSnapshotPage() {
  const { supabase, membership } = await requireOrgMember()

  const now       = new Date()
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  const tomorrow  = new Date(now); tomorrow.setDate(now.getDate() + 1)

  const fmt = (d: Date) => d.toISOString().split('T')[0]

  const [
    { data: turnovers },
    { data: properties },
    { data: openWOs },
    { data: inventoryItems },
    { data: crewMembers },
  ] = await Promise.all([
    supabase
      .from('turnovers')
      .select(`
        id, property_id, checkout_datetime, checkin_datetime,
        window_minutes, status, priority, notes,
        turnover_assignments (
          id,
          crew_members ( id, name )
        )
      `)
      .eq('org_id', membership.org_id)
      .neq('status', 'cancelled')
      .gte('checkout_datetime', fmt(yesterday) + 'T00:00:00')
      .lte('checkout_datetime', fmt(tomorrow)  + 'T23:59:59')
      .order('checkout_datetime'),

    supabase
      .from('properties')
      .select('id, name, city, state')
      .eq('org_id', membership.org_id)
      .eq('is_active', true),

    supabase
      .from('work_orders')
      .select('id, title, property_id, priority, status, scheduled_date')
      .eq('org_id', membership.org_id)
      .in('status', ['pending', 'assigned', 'in_progress'])
      .order('scheduled_date', { ascending: true })
      .limit(8),

    // Fetch all active inventory items and filter below-par client-side
    // (Supabase SDK can't compare two columns in a filter expression)
    supabase
      .from('inventory_items')
      .select('id, name, property_id, current_quantity, par_level')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .limit(200),

    supabase
      .from('crew_members')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true),
  ])

  // Filter below par client-side
  const lowStockItems = (inventoryItems ?? []).filter(
    (i) => i.current_quantity <= i.par_level
  )

  const todayStr = fmt(now)
  const todayTurnovers = (turnovers ?? []).filter((t) =>
    t.checkout_datetime.startsWith(todayStr)
  )
  const unassignedCount = (turnovers ?? []).filter((t) => {
    const assignments = Array.isArray(t.turnover_assignments)
      ? t.turnover_assignments
      : t.turnover_assignments ? [t.turnover_assignments] : []
    return assignments.length === 0 && t.status !== 'completed'
  }).length

  return (
    <OpsSnapshot
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      turnovers={(turnovers ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      properties={(properties ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openWorkOrders={(openWOs ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lowStockItems={lowStockItems as any}
      kpis={{
        turnoversToday: todayTurnovers.length,
        unassigned:     unassignedCount,
        openWorkOrders: openWOs?.length ?? 0,
        belowPar:       lowStockItems.length,
      }}
      dates={{
        yesterday: fmt(yesterday),
        today:     fmt(now),
        tomorrow:  fmt(tomorrow),
      }}
    />
  )
}
