import { requireOrgMember } from '@/lib/auth'
import { TurnoverBoard } from './turnover-board'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { Metadata } from 'next'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Turnovers' }

const TURNOVER_COLUMNS = `
        id, property_id, booking_id, checkout_datetime, checkin_datetime,
        window_minutes, status, priority, notes, completed_at, started_at,
        crew_duration_minutes,
        checklist_template_id, is_same_day_turnover, is_archived,
        suggested_crew_ids, suggestion_reasoning, suggestion_status,
        turnover_assignments (
          id, crew_member_id,
          crew_member:crew_members ( id, name, phone, email )
        )
      `

/** PostgREST's max_rows (supabase/config.toml). A .limit() above it does nothing. */
const PAGE_SIZE = 1000

/**
 * The board's window is 67 days wide, which is NOT inside the 1000-row cap for
 * a large org: 50 properties turning over daily is ~3,350 rows. An unbounded
 * read would have returned the first 1000 with a 200 and no truncation signal,
 * so turnovers would simply be missing from the board with nothing logged.
 * Drained by page instead.
 */
type TurnoverQuery = ReturnType<typeof buildTurnoverPage>
function buildTurnoverPage(
  supabase: Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  orgId: string,
  since: string,
  until: string,
  from: number,
) {
  return supabase
    .from('turnovers')
    .select(TURNOVER_COLUMNS)
    .eq('org_id', orgId)
    .neq('status', 'cancelled')
    .gte('checkout_datetime', since)
    .lte('checkout_datetime', until)
    .order('checkout_datetime', { ascending: true })
    .range(from, from + PAGE_SIZE - 1)
}

async function fetchAllTurnovers(
  supabase: Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  orgId: string,
  since: string,
  until: string,
): Promise<Awaited<TurnoverQuery>> {
  const rows: NonNullable<Awaited<TurnoverQuery>['data']> = []

  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await buildTurnoverPage(supabase, orgId, since, until, from)
    if (result.error) return result
    const page = result.data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return { ...result, data: rows }
  }
}

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
    { data: turnovers, error: turnoversError },
    { data: properties, error: propertiesError },
    { data: bookings, error: bookingsError },
    { data: crew, error: crewError },
    { data: crewAvailability, error: crewAvailabilityError },
    { data: org, error: orgError },
  ] = await Promise.all([
    fetchAllTurnovers(
      supabase,
      membership.org_id,
      since.toISOString(),
      until.toISOString(),
    ),
    supabase
      .from('properties')
      .select('id, name, city, state')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('bookings')
      .select('id, property_id, checkin_date, checkout_date, guest_name, status, source, stay_type')
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

  // Logs + reports every failure, then throws so the segment's error.tsx
  // renders a real error state — an outage must not look like empty data.
  throwIfAnyQueryFailed({ site: 'page.turnovers', orgId: membership.org_id }, turnoversError, propertiesError, bookingsError, crewError, crewAvailabilityError, orgError)

  const propertyMap = Object.fromEntries(
    (properties ?? []).map((p) => [p.id, p])
  )

  const showAutoAssignNudge = org?.auto_assign_mode === 'disabled'

  const stayTypeByBookingId = Object.fromEntries(
    (bookings ?? []).map((b) => [b.id, b.stay_type])
  )

  const normalizedTurnovers = (turnovers ?? []).map((t) => ({
    ...t,
    stay_type: t.booking_id ? (stayTypeByBookingId[t.booking_id] ?? null) : null,
    turnover_assignments: t.turnover_assignments.map((a) => ({
      ...a,
      crew_member: unwrapJoin(a.crew_member),
    })),
  }))

  return (
    <div>
      <TurnoverBoard
        turnovers={normalizedTurnovers}
        propertyMap={propertyMap}
        crewMembers={crew ?? []}
        orgId={membership.org_id}
        properties={properties ?? []}
        bookings={bookings ?? []}
        crewAvailability={crewAvailability ?? []}
        showAutoAssignNudge={showAutoAssignNudge}
      />
    </div>
  )
}
