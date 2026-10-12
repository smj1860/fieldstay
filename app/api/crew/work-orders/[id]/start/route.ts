import { tryUnwrap } from '@/lib/supabase/unwrap'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient }       from '@/lib/supabase/server'
import { requireCrewMember }         from '@/lib/crew-auth'
import { logAuditEvent }             from '@/lib/audit'
import { UUID_RE }                   from '@/lib/validation/uuid'

/**
 * POST /api/crew/work-orders/[id]/start
 *
 * Called by the Dexie SyncEngine outbox when a crew member taps "Start Work"
 * in the crew PWA. The sibling of /start on a turnover, and it exists for the
 * same reason: before this, a crew-assigned work order went straight from
 * `assigned` to `completed`, so a PM watching the board could not tell work
 * that had not been touched from work somebody was in the middle of.
 *
 * A turnover can infer its start from the first checklist tick. A work order
 * cannot: `checklist_instances.turnover_id` is NOT NULL, so a work order has
 * no checklist to infer from and the tap is the only signal there is.
 *
 * No `started_at` is written because `work_orders` has no such column. The
 * `work_order_updates` row below is the timestamp — it is the table that
 * already records every other status transition, so a start recorded any
 * other way would be the one transition missing from the history.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params

  // work_orders.id is a uuid, so a malformed id reaches Postgres and raises
  // 22P02. Answered 400 here rather than letting the read below 503: the read
  // failure path retries, and a malformed id is not transient, so it would
  // 503-loop forever without ever reaching the dead-letter banner (a transport
  // failure never sets `failed`). Same reasoning as the complete route.
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid work order id' }, { status: 400 })
  }

  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { crew, user } = auth

  // Service client: crew has no UPDATE policy on work_orders. Assignment is
  // verified explicitly in the filters below instead of via RLS.
  const supabase = createServiceClient({ crew })

  const woRes = await supabase
    .from('work_orders')
    .select('id, org_id, status')
    .eq('id', id)
    .eq('assigned_crew_member_id', crew.id)
    .eq('org_id', crew.org_id)
    .maybeSingle()

  // 503, not 404, when the READ fails: lib/dexie/net.ts classifies 4xx as
  // TERMINAL and >=500 as transient, so a transient DB error answered with a
  // 404 would dead-letter the crew member's queued start permanently.
  const woOut = tryUnwrap(woRes, { site: 'api.crew.work-orders.start', orgId: crew.org_id })
  if (!woOut.ok) {
    return NextResponse.json({ error: 'Could not load the work order. Please try again.' }, { status: 503 })
  }

  const wo = woOut.data
  if (!wo) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Cancelled is refused, not ignored: nothing removes a cancelled work order
  // from the device (the sync pulls by assigned_crew_member_id with no status
  // filter, and only the crew LIST filters cancelled out), so a crew member
  // can genuinely be looking at one. 409 because 4xx is terminal in
  // lib/dexie/net.ts and this refusal is permanent — retrying it forever is
  // the wrong behaviour. The complete route refuses the same way.
  if (wo.status === 'cancelled') {
    return NextResponse.json(
      { error: 'This work order was cancelled. Check with your manager before doing any more work on it.' },
      { status: 409 },
    )
  }

  // Anything past `assigned` is a no-op, not an error. A replayed upload, a
  // second tap, or a work order a vendor has already moved on must all answer
  // 200 — a non-2xx here would retry forever against a row that will never
  // match again.
  if (wo.status !== 'assigned' && wo.status !== 'pending') {
    return NextResponse.json({ alreadyStarted: true })
  }

  // The WHERE clause, not the read above, is the real guard against two
  // concurrent requests both starting this work order: only one racing
  // UPDATE can match a row still in the prior status.
  const { data: updated, error } = await supabase
    .from('work_orders')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', crew.org_id)
    .eq('status', wo.status)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[CrewWorkOrderStart]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  // Lost the race — the other request already started it and wrote the
  // history row, so don't write a second one.
  if (!updated) return NextResponse.json({ alreadyStarted: true })

  // The status-change history every other transition writes. Not fatal if it
  // fails: the status itself is already committed above, and losing the
  // work order's new state over a missing audit line would be the worse
  // trade. Reported rather than swallowed.
  const { error: updateRowError } = await supabase
    .from('work_order_updates')
    .insert({
      work_order_id:      id,
      org_id:             wo.org_id,
      updated_by_user_id: user.id,
      status_from:        wo.status,
      status_to:          'in_progress',
      notes:              'Work started by crew',
    })

  if (updateRowError) console.error('[CrewWorkOrderStart] history row', updateRowError)

  await logAuditEvent({
    orgId:      wo.org_id,
    actorId:    user.id,
    action:     'work_order.updated',
    targetType: 'work_order',
    targetId:   id,
    metadata:   { change: 'started_by_crew' },
  })

  return NextResponse.json({ started: true })
}
