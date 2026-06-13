import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

/**
 * POST /api/crew/turnovers/[id]/complete
 *
 * Called by the PowerSync upload connector when a crew member marks a
 * turnover complete from the crew PWA. A direct client-side Supabase write
 * can't fire Inngest events, so this route performs the status update and
 * sends `turnover/completed` (cleaning-fee posting, PM notification,
 * crew-duration tracking) — the same pipeline `updateTurnoverStatus` runs
 * for PM-initiated completions.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: turnover_id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .single()

  if (!crew) return NextResponse.json({ error: 'Crew member not found' }, { status: 403 })

  const { data: turnover } = await supabase
    .from('turnovers')
    .select('id, property_id, org_id, status')
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)
    .single()

  if (!turnover) return NextResponse.json({ error: 'Turnover not found' }, { status: 404 })

  // Already completed (e.g. retried upload) — no-op, don't re-fire the event.
  if (turnover.status === 'completed') {
    return NextResponse.json({ success: true })
  }

  const completedAt = new Date().toISOString()

  const { error } = await supabase
    .from('turnovers')
    .update({ status: 'completed', completed_at: completedAt })
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)

  if (error) {
    console.error('[CrewTurnoverComplete]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  await inngest.send({
    name: 'turnover/completed',
    data: {
      turnover_id,
      property_id:          turnover.property_id,
      org_id:               turnover.org_id,
      completed_by_crew_id: crew.id,
      completed_at:         completedAt,
    },
  })

  return NextResponse.json({ success: true })
}
