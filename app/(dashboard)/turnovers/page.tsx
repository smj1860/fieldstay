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

  const [
    { data: turnovers },
    { data: properties },
    { data: crew },
  ] = await Promise.all([
    supabase
      .from('turnovers')
      .select(`
        id, property_id, checkout_datetime, checkin_datetime,
        window_minutes, status, priority, notes, completed_at,
        checklist_template_id,
        turnover_assignments (
          id, crew_member_id,
          crew_members ( id, name, phone, email )
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
      .from('crew_members')
      .select('id, name, phone, email, specialty')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  const propertyMap = Object.fromEntries(
    (properties ?? []).map((p) => [p.id, p])
  )

  return (
    <div>
      <TurnoverBoard
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        turnovers={(turnovers ?? []) as any}
        propertyMap={propertyMap}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        crewMembers={(crew ?? []) as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties={(properties ?? []) as any}
        orgId={membership.org_id}
      />
    </div>
  )
}
