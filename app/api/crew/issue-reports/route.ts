import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)

  const turnover_id = typeof body?.turnover_id === 'string' ? body.turnover_id : null
  const title        = typeof body?.title === 'string' ? body.title.trim() : ''
  const description  = typeof body?.description === 'string' ? (body.description.trim() || null) : null
  const priority      = ['medium', 'high', 'urgent'].includes(body?.priority) ? body.priority : 'medium'

  if (!turnover_id) return NextResponse.json({ error: 'Missing turnover_id' }, { status: 400 })
  if (!title)       return NextResponse.json({ error: 'Missing title' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!crew) return NextResponse.json({ error: 'Crew member not found' }, { status: 403 })

  const { data: turnover } = await supabase
    .from('turnovers')
    .select('id, property_id, org_id')
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)
    .single()

  if (!turnover) return NextResponse.json({ error: 'Turnover not found' }, { status: 404 })

  // Idempotency — the Dexie SyncEngine outbox may retry the same upload after a
  // connectivity blip. Treat a matching report submitted in the last 10 minutes
  // as already processed instead of creating a duplicate work order.
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { data: existing } = await supabase
    .from('work_orders')
    .select('id')
    .eq('source_turnover_id', turnover_id)
    .eq('source', 'crew_flag')
    .eq('title', title)
    .gte('created_at', tenMinutesAgo)
    .maybeSingle()

  if (existing) return NextResponse.json({ success: true })

  const { error } = await supabase.from('work_orders').insert({
    org_id:             turnover.org_id,
    property_id:        turnover.property_id,
    source_turnover_id: turnover.id,
    title,
    description,
    priority,
    status: 'pending',
    source: 'crew_flag',
  })

  if (error) {
    console.error('[CrewIssueReport]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  await logAuditEvent({
    orgId:      crew.org_id as string,
    actorId:    user.id,
    action:     'work_order.created',
    targetType: 'work_order',
    metadata:   { source: 'crew_flag', turnover_id, title },
  })

  return NextResponse.json({ success: true })
}
