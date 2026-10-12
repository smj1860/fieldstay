import 'server-only'
import { NextResponse } from 'next/server'
import { requireCrewMember } from '@/lib/crew-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { tryUnwrap } from '@/lib/supabase/unwrap'
import { UUID_RE } from '@/lib/validation/uuid'

/**
 * The shared prologue for every crew WORK ORDER route: reject a malformed id,
 * authenticate, load the work order scoped to the crew member's own org AND
 * their own assignment, and refuse one that has been cancelled.
 *
 * The sibling of lib/turnovers/crew-route-context.ts, and it exists for the
 * same reason that one does. Every answer below was paid for once on the
 * completion route:
 *
 *   • malformed id → 400. work_orders.id is a uuid, so a bad one reaches
 *     Postgres and raises 22P02. Answered by the read path it would otherwise
 *     fall into, that is a 503 — and a malformed id is not transient, so it
 *     503-loops forever: the outbox never drains, the logout "unsynced work"
 *     warning stays armed, and none of it reaches the dead-letter banner,
 *     because a transport failure never sets `failed`.
 *   • read failed  → 503, so the outbox RETRIES. lib/dexie/net.ts classifies
 *     4xx as TERMINAL and >=500 as transient, so a 404 on a transient database
 *     error permanently dead-letters the crew member's queued mutation.
 *   • no row       → 404, covering both "does not exist" and "not yours". The
 *     lookup filters on assigned_crew_member_id, so an unassigned crew member
 *     gets exactly what an unknown id gets rather than a 403 confirming the id
 *     is real.
 *   • cancelled    → 409, and 4xx is terminal, which is the point: the refusal
 *     is permanent and must not retry. Nothing removes a cancelled work order
 *     from the device (the crew sync pulls by assigned_crew_member_id with no
 *     status filter, and only the crew LIST filters cancelled out), so a crew
 *     member can genuinely be looking at one. Completing one used to flip it
 *     to `completed` and run the whole side-effect chain, including the
 *     owner_transactions maintenance expense, for work that was called off.
 *
 * Sharing the CONTROL FLOW is the point. The turnover pair of routes drifted
 * precisely because the second one was written by copying the first, and one
 * implementation cannot disagree with itself.
 */

type CrewAuth = Extract<Awaited<ReturnType<typeof requireCrewMember>>, { ok: true }>

export type CrewWorkOrderContext<T> =
  | { ok: true;  auth: CrewAuth; supabase: ReturnType<typeof createServiceClient>; workOrder: T }
  | { ok: false; response: NextResponse }

export async function loadCrewWorkOrderContext<T extends { id: string; status: string }>(
  workOrderId: string,
  /**
   * The columns this route needs. Passed in rather than fixed, because the
   * routes genuinely read different fields — the completion route needs the
   * wo_number and title for its PM notification and this one does not.
   * `id` and `status` are required by the type, since the guards below read
   * them.
   */
  columns: string,
  site: string,
  /**
   * Run after authentication and BEFORE the work-order read. Return a
   * response to stop there, or null to continue.
   *
   * This seam exists for one real property: the completion route rejects an
   * oversized `notes` body without spending a database round trip on it. Put
   * that check after the read and an obviously invalid request still costs a
   * query, and a bad body against an id that is not yours answers 404 rather
   * than telling the caller what was actually wrong with their request.
   *
   * It runs after auth rather than before it so an unauthenticated caller
   * still gets 401, and learns nothing about our validation rules.
   */
  beforeRead?: () => NextResponse | null,
): Promise<CrewWorkOrderContext<T>> {
  if (!UUID_RE.test(workOrderId)) {
    return { ok: false, response: NextResponse.json({ error: 'Invalid work order id' }, { status: 400 }) }
  }

  const auth = await requireCrewMember()
  if (!auth.ok) return { ok: false, response: auth.response }
  const { crew } = auth

  const early = beforeRead?.()
  if (early) return { ok: false, response: early }

  // Service client: crew has no UPDATE policy on work_orders by design. The
  // assignment is verified explicitly in the filters below instead of by RLS,
  // which is why those two .eq()s are the whole tenant boundary here.
  const supabase = createServiceClient({ crew })

  const woRes = await supabase
    .from('work_orders')
    .select(columns)
    .eq('id', workOrderId)
    .eq('assigned_crew_member_id', crew.id)
    .eq('org_id', crew.org_id)
    .maybeSingle()

  const woOut = tryUnwrap<T>(woRes as never, { site, orgId: crew.org_id })
  if (!woOut.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Could not load the work order. Please try again.' },
        { status: 503 },
      ),
    }
  }

  const workOrder = woOut.data
  if (!workOrder) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }

  if (workOrder.status === 'cancelled') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'This work order was cancelled. Check with your manager before doing any more work on it.' },
        { status: 409 },
      ),
    }
  }

  return { ok: true, auth, supabase, workOrder }
}
