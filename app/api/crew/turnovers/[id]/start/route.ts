import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

/**
 * POST /api/crew/turnovers/[id]/start
 *
 * Called by the Dexie SyncEngine outbox when a crew member taps
 * "Start Turnover" in the crew PWA. Routes through the server so
 * started_at is set authoritatively (not from client clock) and the
 * transition is validated against crew membership.
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
    .select('id, org_id, status')
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)
    .single()

  if (!turnover) return NextResponse.json({ error: 'Turnover not found' }, { status: 404 })

  // Already in progress or further along — no-op (safe for retried uploads)
  if (turnover.status !== 'assigned') {
    return NextResponse.json({ success: true })
  }

  const startedAt = new Date().toISOString()

  const { error } = await supabase
    .from('turnovers')
    .update({
      status:     'in_progress',
      started_at: startedAt,
    })
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)

  if (error) {
    console.error('[CrewTurnoverStart]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  await inngest.send({
    name: 'turnover/started',
    data: {
      turnover_id,
      org_id:             turnover.org_id,
      started_by_crew_id: crew.id,
      started_at:         startedAt,
    },
  })

  return NextResponse.json({ success: true })
}
