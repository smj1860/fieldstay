import 'server-only'
import { NextResponse } from 'next/server'
import { requireCrewMember } from '@/lib/crew-auth'
import { tryUnwrap } from '@/lib/supabase/unwrap'
import { isCrewAssignedToTurnover } from '@/lib/turnovers/assignment'

/**
 * The shared prologue for every crew turnover route: authenticate, load the
 * turnover scoped to the crew member's own org, and confirm they are actually
 * assigned to it.
 *
 * This exists because the two routes that need it DIVERGED, and the divergence
 * was the bug. The start route was hardened to answer a failed READ with 503
 * rather than 404 — lib/dexie/net.ts classifies 4xx as TERMINAL and >=500 as
 * transient, so a 404 on a transient DB error permanently DEAD-LETTERS the
 * crew member's queued mutation instead of retrying it. The complete route
 * kept `const { data } = await ... .single()`, so it went on discarding
 * finished work for months: the job was done, the PM never saw it finish, and
 * the cleaning fee never posted.
 *
 * Copying the fix into the second route would have left the same shape that
 * allowed the drift. One implementation cannot disagree with itself.
 *
 * Every failure answer is deliberate:
 *
 *   • read failed        → 503, so the outbox RETRIES (see above)
 *   • no row             → 404
 *   • not assigned       → 404, NOT 403. Org scoping alone lets any active
 *     crew member in the org act on any turnover in it; 403 would confirm the
 *     id exists to someone who should not know that, so an unassigned crew
 *     member gets exactly what an unknown id gets.
 */

type CrewAuth = Extract<Awaited<ReturnType<typeof requireCrewMember>>, { ok: true }>

export type CrewTurnoverContext<T> =
  | { ok: true;  auth: CrewAuth; turnover: T }
  | { ok: false; response: NextResponse }

export async function loadCrewTurnoverContext<T extends { id: string }>(
  turnoverId: string,
  /**
   * The columns this route needs. Passed in rather than fixed, because the two
   * routes genuinely read different fields — sharing the CONTROL FLOW is the
   * point, not forcing them to over-select.
   */
  columns: string,
  site: string,
): Promise<CrewTurnoverContext<T>> {
  const auth = await requireCrewMember()
  if (!auth.ok) return { ok: false, response: auth.response }

  const { supabase, crew } = auth

  const turnoverRes = await supabase
    .from('turnovers')
    .select(columns)
    .eq('id', turnoverId)
    .eq('org_id', crew.org_id)
    .maybeSingle()

  const turnoverOut = tryUnwrap<T>(turnoverRes as never, { site, orgId: crew.org_id })
  if (!turnoverOut.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Could not load the turnover. Please try again.' },
        { status: 503 },
      ),
    }
  }

  const turnover = turnoverOut.data
  if (!turnover) {
    return { ok: false, response: NextResponse.json({ error: 'Turnover not found' }, { status: 404 }) }
  }

  if (!(await isCrewAssignedToTurnover(supabase, turnoverId, crew.id))) {
    return { ok: false, response: NextResponse.json({ error: 'Turnover not found' }, { status: 404 }) }
  }

  return { ok: true, auth, turnover }
}
