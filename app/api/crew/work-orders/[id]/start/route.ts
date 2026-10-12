import { NextRequest, NextResponse } from 'next/server'
import { logAuditEvent }             from '@/lib/audit'
import { loadCrewWorkOrderContext }  from '@/lib/work-orders/crew-route-context'

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
 *
 * The id check, auth, org/assignment scoping and the cancelled refusal all
 * live in loadCrewWorkOrderContext, shared with the completion route. Each of
 * those answers is load-bearing for the outbox; see that module.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params

  const ctx = await loadCrewWorkOrderContext<{ id: string; org_id: string; status: string }>(
    id,
    'id, org_id, status',
    'api.crew.work-orders.start',
  )
  if (!ctx.ok) return ctx.response

  const { supabase, workOrder: wo } = ctx
  const { user, crew } = ctx.auth

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
  // fails: the status itself is already committed above, and losing the work
  // order's new state over a missing audit line would be the worse trade.
  const { error: historyError } = await supabase
    .from('work_order_updates')
    .insert({
      work_order_id:      id,
      org_id:             wo.org_id,
      updated_by_user_id: user.id,
      status_from:        wo.status,
      status_to:          'in_progress',
      notes:              'Work started by crew',
    })

  if (historyError) console.error('[CrewWorkOrderStart] history row', historyError)

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
