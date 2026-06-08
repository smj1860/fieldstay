import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  const { token } = body as { token: string }

  // Derive the binding user from the authenticated session — never from the client body
  const supabaseAuth = await createClient()
  const { data: { user } } = await supabaseAuth.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Must be signed in to accept an invite' }, { status: 401 })
  }

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
      user_id:            user.id,
      invite_accepted_at: new Date().toISOString(),
    })
    .eq('id', crew.id)
    .is('user_id', null)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
