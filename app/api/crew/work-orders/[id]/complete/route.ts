import { NextRequest, NextResponse } from 'next/server'
import { inngest }                   from '@/lib/inngest/client'
import { logAuditEvent }             from '@/lib/audit'
import { loadCrewWorkOrderContext }  from '@/lib/work-orders/crew-route-context'
import {
  workOrderCompletionFields,
  finalizeWorkOrderCompletion,
  COMPLETED_WORK_ORDER_SELECT,
  type CompletedWorkOrderRow,
} from '@/app/(dashboard)/maintenance/complete-work-order-helpers'
import type { WoStatus } from '@/types/database'

/**
 * POST /api/crew/work-orders/[id]/complete
 *
 * Called from the crew PWA when a crew member marks a crew-assigned work
 * order complete. Authenticates the crew member, verifies the WO is assigned
 * to them, flips status to completed, records a status update note, and
 * notifies the PM via Inngest (work-order/crew.completed).
 */
/**
 * work_orders.id is a `uuid`, so a malformed id in the path does not fail a
 * type check — it reaches Postgres and raises 22P02. This route deliberately
 * answers a failed READ with 503 so a TRANSIENT database error retries rather
 * than dead-lettering the crew member's queued completion. A malformed id is
 * not transient, so without this check it would 503-loop forever: the outbox
 * never drains, the logout "unsynced work" warning stays armed, and none of it
 * is visible to the dead-letter banner because a transport failure never sets
 * the `failed` flag.
 *
 * Not reachable from our own client (the PWA builds the URL from cached
 * crew_work_orders ids), which is why it is asserted rather than assumed.
 */


/** Free text typed on a phone into an unbounded `completion_notes` column. */
const MAX_NOTES_LENGTH = 2000

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params

  // The id check, crew auth, org/assignment scoping and the cancelled refusal
  // are shared with the start route (lib/work-orders/crew-route-context.ts).
  // They were hand-rolled here first and every one of them was paid for once;
  // the second route copying them is exactly how the turnover pair drifted,
  // so there is now one implementation that cannot disagree with itself.
  // Parsed before the context load so the length check can run inside its
  // beforeRead seam: an oversized body must not cost a database round trip,
  // and must answer 400 rather than a 404 that hides what was wrong.
  const { notes } = (await req.json().catch(() => ({}))) as { notes?: string }

  const ctx = await loadCrewWorkOrderContext<{
    id: string; wo_number: string | null; title: string
    property_id: string; org_id: string; status: string
  }>(
    id,
    'id, wo_number, title, property_id, org_id, assigned_crew_member_id, status',
    'api.crew.work-orders.complete',
    () => (typeof notes === 'string' && notes.length > MAX_NOTES_LENGTH
      ? NextResponse.json(
          { error: `Completion notes are too long. Please keep them under ${MAX_NOTES_LENGTH} characters.` },
          { status: 400 },
        )
      : null),
  )
  if (!ctx.ok) return ctx.response

  const { supabase, workOrder: wo } = ctx
  const { user, crew } = ctx.auth

  if (wo.status === 'completed') return NextResponse.json({ alreadyCompleted: true })

  const trimmedNotes = notes?.trim() ? notes.trim() : 'Marked complete by crew'

  // The WHERE clause (not the earlier read) is the real guard against a
  // concurrent duplicate request completing the WO twice — .neq ensures
  // only one racing request's UPDATE actually matches a row.
  //
  // The column payload comes from workOrderCompletionFields() and the row is
  // selected back as COMPLETED_WORK_ORDER_SELECT so this path can hand it to
  // finalizeWorkOrderCompletion below. Writing the columns inline is what made
  // this a FOURTH completion path that silently skipped every side effect:
  // no work-order/completed event (so no owner_transactions maintenance
  // expense) and, worse, no source-schedule advance — leaving next_due_date
  // untouched, so the nightly cron kept seeing the schedule as due, kept
  // colliding with wo_maintenance_schedule_date_unique, and kept discarding
  // the 23505 as an expected lost race. The schedule stopped recurring
  // permanently, with nothing logged anywhere.
  const { data: updated, error } = await supabase
    .from('work_orders')
    .update({
      ...workOrderCompletionFields(trimmedNotes),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .neq('status', 'completed')
    .neq('status', 'cancelled')
    .select(COMPLETED_WORK_ORDER_SELECT)
    .maybeSingle()

  if (error) {
    console.error('[CrewWorkOrderComplete]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  // Lost the race to a concurrent request — it already completed this WO.
  if (!updated) return NextResponse.json({ alreadyCompleted: true })

  // Every completion side effect — the work-order/completed event (which posts
  // the owner_transactions maintenance expense), the work_order_updates audit
  // row, and the source maintenance-schedule advance. Called with the row the
  // UPDATE actually claimed, so a lost race fans out nothing.
  //
  // This also writes the work_order_updates row this route used to insert
  // itself; doing both would double-log the status change.
  await finalizeWorkOrderCompletion(supabase, wo.org_id, [updated as CompletedWorkOrderRow], {
    statusFromById:  new Map([[id, wo.status as WoStatus | null]]),
    notes:           trimmedNotes,
    updatedByUserId: user.id,
  })

  // Notify PM via Inngest. Kept alongside work-order/completed: this is the
  // crew-specific PM notification ("✓ Work Complete — WO-123"), while
  // handleWorkOrderCompleted only posts the expense, so the two do not
  // produce duplicate notifications.
  await inngest.send({
    name: 'work-order/crew.completed',
    data: {
      workOrderId:  id,
      orgId:        wo.org_id,
      crewMemberId: crew.id,
      completedAt:  new Date().toISOString(),
      notes:        notes?.trim() ? notes.trim() : null,
    },
  })

  await logAuditEvent({
    orgId:      wo.org_id,
    actorId:    user.id,
    action:     'work_order.updated',
    targetType: 'work_order',
    targetId:   id,
    metadata:   { change: 'completed_by_crew' },
  })

  return NextResponse.json({ completed: true })
}
