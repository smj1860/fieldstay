import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember } from '@/lib/crew-auth'

export async function POST(request: NextRequest) {
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { supabase, crew } = auth

  const body = await request.json().catch(() => null)
  if (!body?.endpoint || !body?.p256dh || !body?.auth) {
    return NextResponse.json({ error: 'Invalid subscription data' }, { status: 400 })
  }

  await supabase
    .from('push_subscriptions')
    .upsert(
      {
        crew_member_id: crew.id,
        org_id:         crew.org_id,
        endpoint:       body.endpoint,
        p256dh:         body.p256dh,
        auth:           body.auth,
      },
      { onConflict: 'crew_member_id,endpoint' }
    )

  return NextResponse.json({ success: true })
}
