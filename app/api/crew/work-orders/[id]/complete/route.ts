import { tryUnwrap } from '@/lib/supabase/unwrap'
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient }       from '@/lib/supabase/server'
import { requireCrewMember }         from '@/lib/crew-auth'
import { inngest }                   from '@/lib/inngest/client'
import { logAuditEvent }             from '@/lib/audit'
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
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params

  // Canonical crew auth gate (lib/crew-auth.ts). This route was the last
  // straggler on the inline-lookup pattern the 2026-07-22 crew-auth sweep
  // replaced everywhere else — surfaced by the service-role-authorization
  // guardrail the day it landed.
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { crew, user } = auth

  const { notes } = (await req.json().catch(() => ({}))) as { notes?: string }

  // Service client for the WO read/update — crew role has no UPDATE policy on
  // work_orders; assignment is verified explicitly below instead of via RLS.
  const supabase = createServiceClient({ crew })

  const woRes = await supabase
    .from('work_orders')
    .select('id, wo_number, title, property_id, org_id, assigned_crew_member_id, status')
    .eq('id', id)
    .eq('assigned_crew_member_id', crew.id)
    .eq('org_id', crew.org_id)
    .maybeSingle()

  // 503, not 404, when the READ fails: lib/dexie/net.ts classifies 4xx as
  // TERMINAL and >=500 as transient, so answering a transient DB error with a
  // 404 dead-lettered the crew member's queued mutation permanently instead of
  // retrying it. A genuinely missing row still returns 404.
  const woOut = tryUnwrap(woRes, { site: 'api.crew.work-orders.complete', orgId: crew.org_id })
  if (!woOut.ok) {
    return NextResponse.json({ error: 'Could not load the work order. Please try again.' }, { status: 503 })
  }

  const wo = woOut.data
  if (!wo)                       return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (wo.status === 'completed') return NextResponse.json({ alreadyCompleted: true })

  // A cancelled work order must not be completable, and nothing else stopped
  // it: the check above only catches `completed`, and the UPDATE's
  // `.neq('status', 'completed')` below MATCHES a cancelled row. So completing
  // one flipped it to `completed` and ran the full side-effect chain —
  // including the owner_transactions maintenance expense — for work that was
  // called off. This is the turnover complete route's guard, which that route
  // already had and this one did not.
  //
  // Nothing removes a cancelled work order from the crew's device either: the
  // sync pulls by assigned_crew_member_id with no status filter, and only the
  // crew LIST filters cancelled out. 409 deliberately — lib/dexie/net.ts
  // treats 4xx as terminal, and this refusal is permanent, so retrying it
  // forever is the wrong behaviour.
  if (wo.status === 'cancelled') {
    return NextResponse.json(
      { error: 'This work order was cancelled. Check with your manager before doing any more work on it.' },
      { status: 409 },
    )
  }

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
