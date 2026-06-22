import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) return NextResponse.json({ error: 'Not an org member' }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (
    typeof body?.endpoint !== 'string' ||
    typeof body?.p256dh   !== 'string' ||
    typeof body?.auth     !== 'string'
  ) {
    return NextResponse.json({ error: 'Invalid subscription data' }, { status: 400 })
  }

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id:  user.id,
        org_id:   membership.org_id,
        endpoint: body.endpoint,
        p256dh:   body.p256dh,
        auth:     body.auth,
      },
      { onConflict: 'user_id,endpoint' }
    )

  if (error) {
    console.error('[push-subscribe] upsert failed:', error.message)
    return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
