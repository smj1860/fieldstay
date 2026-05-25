import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.token || !body?.userId) {
    return NextResponse.json({ error: 'Missing token or userId' }, { status: 400 })
  }

  const { token, userId } = body as { token: string; userId: string }
  const supabase = createServiceClient()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, user_id, invite_accepted_at')
    .eq('invite_token', token)
    .single()

  if (!crew) {
    return NextResponse.json({ error: 'Invalid invite token' }, { status: 404 })
  }

  if (crew.user_id || crew.invite_accepted_at) {
    return NextResponse.json({ error: 'Invite already used' }, { status: 409 })
  }

  const { error } = await supabase
    .from('crew_members')
    .update({
      user_id:            userId,
      invite_accepted_at: new Date().toISOString(),
    })
    .eq('id', crew.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
