import { unwrap } from '@/lib/supabase/unwrap'
import { redirect }        from 'next/navigation'
import { createClient }    from '@/lib/supabase/server'
import { TimeOffRequest }  from '@/components/crew/time-off-request'

/**
 * Time off is an online-only screen — see ./actions.ts for why. Rows are read
 * here rather than from the Dexie cache, so crew_availability no longer has to
 * be synced to every crew device on a five-minute poll to back a screen that
 * needs a connection to be useful anyway.
 */
export const dynamic = 'force-dynamic'

/**
 * The window the crew calendar can actually navigate to. Imported from the
 * action rather than redeclared, so the range this page SHOWS and the range
 * the action ACCEPTS cannot drift apart.
 */
import { LOOKBACK_DAYS, LOOKAHEAD_DAYS } from './actions'

export default async function CrewAvailabilityPage() {
  const supabase                = await createClient()
  const { data: { user } }      = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // A failed read used to bounce the crew member to /login, which reads as
  // "you are signed out" during what is really a transient DB error.
  const crewMemberRes = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .maybeSingle()

  const crewMember = unwrap(crewMemberRes, { site: 'page.crew.availability' })
  if (!crewMember) redirect('/login')

  // `new Date()` rather than `Date.now()` arithmetic — the latter trips
  // react-hooks/purity in a Server Component render, and this matches how the
  // dashboard's other server pages build their date windows.
  const fromDate = new Date()
  fromDate.setDate(fromDate.getDate() - LOOKBACK_DAYS)
  const toDate = new Date()
  toDate.setDate(toDate.getDate() + LOOKAHEAD_DAYS)

  const from = fromDate.toISOString().slice(0, 10)
  const to   = toDate.toISOString().slice(0, 10)

  // Own rows only — crew_member_id is the isolation guard, the same one the
  // sync function this replaces relied on.
  //
  // The limit is an exact bound rather than a truncating cap: crew_availability
  // is UNIQUE (crew_member_id, available_date), so the window can hold at most
  // one row per day in it. Without it this is an unbounded .select() and
  // PostgREST's max_rows would decide the cutoff silently.
  const availabilityRes = await supabase
    .from('crew_availability')
    .select('id, available_date, is_available, notes')
    .eq('crew_member_id', crewMember.id as string)
    .gte('available_date', from)
    .lte('available_date', to)
    .order('available_date', { ascending: true })
    .limit(LOOKBACK_DAYS + LOOKAHEAD_DAYS + 1)

  const availability = unwrap(availabilityRes, {
    site:  'page.crew.availability.rows',
    orgId: crewMember.org_id as string,
  })

  return (
    <div className="px-4 pt-4 pb-24">
      <TimeOffRequest rows={availability ?? []} />
    </div>
  )
}
