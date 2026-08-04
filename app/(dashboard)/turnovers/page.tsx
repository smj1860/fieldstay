import { requireOrgMember } from '@/lib/auth'
import { TurnoverBoard } from './turnover-board'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { Metadata } from 'next'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { reportError } from '@/lib/observability/report-error'

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

/**
 * Every read on this page is drained through fetchAllRows, and every one of
 * them ends in `.order('id')`.
 *
 * ORDER MATTERS, and not for presentation. `.range()` is OFFSET pagination:
 * page 2 asks the database for "rows 999-1997 of this ordering", so the
 * ordering has to be TOTAL or the two pages are answering different questions.
 * checkout_datetime is emphatically not unique — short-term rentals share a
 * standard checkout hour, so a 50-property org has dozens of rows on the same
 * timestamp — and Postgres is free to break those ties differently in two
 * separately-planned queries. The result is rows returned twice (duplicate
 * React keys, duplicate cards) AND rows returned never, which is the exact
 * defect the pagination was added to fix. `id` as a final tiebreaker makes the
 * sort total. See the "MUST apply a stable .order(...)" note in
 * lib/inngest/paginate.ts.
 *
 * The window is 67 days wide, which is NOT inside PostgREST's 1000-row cap for
 * a large org — ~3,350 turnovers and ~3,350 availability rows at 50 properties
 * / 50 crew. Truncation there is silent: a 200, no error, no signal. For
 * bookings it is worse than silent, because stayTypeByBookingId turns a
 * truncated booking into `stay_type: null`, which is indistinguishable from a
 * booking that genuinely has no stay type.
 *
 * maxRows is per-read and deliberately snug: blowing it throws a labelled
 * error rather than paging on forever inside a Server Component render.
 */
const MAX_BOARD_ROWS = 20_000

export default async function TurnoversPage() {
  const { supabase, membership } = await requireOrgMember()

  // Fetch turnovers for the next 60 days + last 7 days
  const since = new Date()
  since.setDate(since.getDate() - 7)
  const until = new Date()
  until.setDate(until.getDate() + 60)

  const rangeStart = since.toISOString().split('T')[0]!
  const rangeEnd   = until.toISOString().split('T')[0]!

  // fetchAllRows THROWS on a failed page rather than returning { data, error },
  // which is the same end state this page already wanted — but it throws a
  // plain Error with no Sentry context, so the batch is wrapped to report once
  // with the call site before rethrowing. Rethrowing is deliberate: the
  // segment's error.tsx must render a real error state, never empty data.
  let turnovers, properties, bookings, crew, crewAvailability, orgResult
  try {
    ;[turnovers, properties, bookings, crew, crewAvailability, orgResult] = await Promise.all([
      fetchAllRows(
        (from, to) => supabase
          .from('turnovers')
          .select(TURNOVER_COLUMNS)
          .eq('org_id', membership.org_id)
          .neq('status', 'cancelled')
          .gte('checkout_datetime', since.toISOString())
          .lte('checkout_datetime', until.toISOString())
          .order('checkout_datetime', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'page.turnovers.turnovers', maxRows: MAX_BOARD_ROWS },
      ),
      fetchAllRows(
        (from, to) => supabase
          .from('properties')
          .select('id, name, city, state')
          .eq('org_id', membership.org_id)
          .eq('is_active', true)
          .order('name')
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'page.turnovers.properties', maxRows: MAX_BOARD_ROWS },
      ),
      fetchAllRows(
        (from, to) => supabase
          .from('bookings')
          .select('id, property_id, checkin_date, checkout_date, guest_name, status, source, stay_type')
          .eq('org_id', membership.org_id)
          .gte('checkout_date', rangeStart)
          .lte('checkin_date',  rangeEnd)
          .in('status', ['confirmed', 'tentative'])
          .order('checkin_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'page.turnovers.bookings', maxRows: MAX_BOARD_ROWS },
      ),
      fetchAllRows(
        (from, to) => supabase
          .from('crew_members')
          .select('id, name, phone, email, specialty')
          .eq('org_id', membership.org_id)
          .eq('is_active', true)
          .order('name')
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'page.turnovers.crew_members', maxRows: MAX_BOARD_ROWS },
      ),
      fetchAllRows(
        (from, to) => supabase
          .from('crew_availability')
          .select('id, crew_member_id, available_date, is_available')
          .eq('org_id', membership.org_id)
          .gte('available_date', rangeStart)
          .lte('available_date', rangeEnd)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'page.turnovers.crew_availability', maxRows: MAX_BOARD_ROWS },
      ),
      supabase
        .from('organizations')
        .select('auto_assign_mode')
        .eq('id', membership.org_id)
        .single(),
    ])
  } catch (err) {
    reportError(err, { site: 'page.turnovers', orgId: membership.org_id })
    throw err
  }

  // Logs + reports the failure, then throws so the segment's error.tsx renders
  // a real error state — an outage must not look like empty data.
  throwIfAnyQueryFailed({ site: 'page.turnovers', orgId: membership.org_id }, orgResult.error)
  const org = orgResult.data

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
