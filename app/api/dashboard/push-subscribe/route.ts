import { tryUnwrap, reportQueryError } from '@/lib/supabase/unwrap'
import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // maybeSingle() + tryUnwrap: a failed read used to answer 403 "Not an org
  // member", which reads as a permissions problem rather than an outage.
  const membershipRes = await supabase
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .maybeSingle()

  const membershipOut = tryUnwrap(membershipRes, { site: 'api.dashboard.push-subscribe' })
  if (!membershipOut.ok) {
    return NextResponse.json({ error: 'Could not verify membership. Please try again.' }, { status: 503 })
  }

  const membership = membershipOut.data
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

  // reportQueryError, not console.error. This route carried the SAME 42P10
  // upsert defect as the crew route from 2026-06-20 to 2026-08-17, and only the
  // crew one ever raised a Sentry issue — because that one reports and this one
  // logged to a console nobody reads. Two months of PM-side push opt-in failing
  // with no signal anywhere. The bug was in the index; the two-month delay in
  // finding it was here.
  if (reportQueryError(error, { site: 'route.dashboard.pushSubscribe', orgId: membership.org_id })) {
    return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
