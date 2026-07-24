import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient }       from '@/lib/supabase/server'
import { requireCrewMember }         from '@/lib/crew-auth'
import { inngest }                   from '@/lib/inngest/client'
import { logAuditEvent }             from '@/lib/audit'

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

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, wo_number, title, property_id, org_id, assigned_crew_member_id, status')
    .eq('id', id)
    .eq('assigned_crew_member_id', crew.id)
    .eq('org_id', crew.org_id)
    .single()

  if (!wo)                       return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (wo.status === 'completed') return NextResponse.json({ alreadyCompleted: true })

  // The WHERE clause (not the earlier read) is the real guard against a
  // concurrent duplicate request completing the WO twice — .neq ensures
  // only one racing request's UPDATE actually matches a row.
  const { data: updated, error } = await supabase
    .from('work_orders')
    .update({
      status:         'completed',
      completed_date: new Date().toISOString().split('T')[0],
      updated_at:     new Date().toISOString(),
    })
    .eq('id', id)
    .neq('status', 'completed')
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[CrewWorkOrderComplete]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  // Lost the race to a concurrent request — it already completed this WO.
  if (!updated) return NextResponse.json({ alreadyCompleted: true })

  // Record the status change (+ optional note) in the WO update log
  await supabase.from('work_order_updates').insert({
    work_order_id:             id,
    org_id:                    wo.org_id,
    updated_by_user_id:        user.id,
    updated_via_vendor_portal: false,
    status_from:               wo.status,
    status_to:                 'completed',
    notes:                     notes?.trim() ? notes.trim() : 'Marked complete by crew',
  })

  // Notify PM via Inngest
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
