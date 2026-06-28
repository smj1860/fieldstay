import { requireOrgMember } from '@/lib/auth'
import { TurnoverBoard } from './turnover-board'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Turnovers' }

export default async function TurnoversPage() {
  const { supabase, membership } = await requireOrgMember()

  // Fetch turnovers for the next 60 days + last 7 days
  const since = new Date()
  since.setDate(since.getDate() - 7)
  const until = new Date()
  until.setDate(until.getDate() + 60)

  const rangeStart = since.toISOString().split('T')[0]!
  const rangeEnd   = until.toISOString().split('T')[0]!

  const [
    { data: turnovers },
    { data: properties },
    { data: bookings },
    { data: crew },
    { data: crewAvailability },
    { data: org },
  ] = await Promise.all([
    supabase
      .from('turnovers')
      .select(`
        id, property_id, checkout_datetime, checkin_datetime,
        window_minutes, status, priority, notes, completed_at, started_at,
        checklist_template_id, is_same_day_turnover, is_archived,
        suggested_crew_ids, suggestion_reasoning, suggestion_status,
        turnover_assignments (
          id, crew_member_id,
          crew_member:crew_members ( id, name, phone, email )
        )
      `)
      .eq('org_id', membership.org_id)
      .neq('status', 'cancelled')
      .gte('checkout_datetime', since.toISOString())
      .lte('checkout_datetime', until.toISOString())
      .order('checkout_datetime', { ascending: true }),
    supabase
      .from('properties')
      .select('id, name, city, state')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('bookings')
      .select('id, property_id, checkin_date, checkout_date, guest_name, status, source')
      .eq('org_id', membership.org_id)
      .gte('checkout_date', rangeStart)
      .lte('checkin_date',  rangeEnd)
      .in('status', ['confirmed', 'tentative'])
      .order('checkin_date', { ascending: true }),
    supabase
      .from('crew_members')
      .select('id, name, phone, email, specialty')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('crew_availability')
      .select('crew_member_id, available_date, is_available')
      .eq('org_id', membership.org_id)
      .gte('available_date', rangeStart)
      .lte('available_date', rangeEnd),
    supabase
      .from('organizations')
      .select('auto_assign_mode')
      .eq('id', membership.org_id)
      .single(),
  ])

  const propertyMap = Object.fromEntries(
    (properties ?? []).map((p) => [p.id, p])
  )

  const showAutoAssignNudge = org?.auto_assign_mode === 'disabled'

  const normalizedTurnovers = (turnovers ?? []).map((t) => ({
    ...t,
    turnover_assignments: t.turnover_assignments.map((a) => ({
      ...a,
      crew_member: Array.isArray(a.crew_member)
        ? (a.crew_member[0] ?? null)
        : (a.crew_member ?? null),
    })),
  }))

  return (
    <div>
      <TurnoverBoard
        turnovers={normalizedTurnovers}
        propertyMap={propertyMap}
        crewMembers={crew ?? []}
        properties={properties ?? []}
        bookings={bookings ?? []}
        crewAvailability={crewAvailability ?? []}
        orgId={membership.org_id}
        showAutoAssignNudge={showAutoAssignNudge}
      />
    </div>
  )
}
