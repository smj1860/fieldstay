import { NextRequest, NextResponse }  from 'next/server'
import { cookies }                    from 'next/headers'
import { createServerClient }         from '@supabase/ssr'
import { createServiceClient }        from '@/lib/supabase/server'
import { inngest }                    from '@/lib/inngest/client'
import { logAuditEvent }              from '@/lib/audit'

export async function POST(_request: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createServiceClient()

  // 1. Resolve membership with role
  const { data: membership } = await admin
    .from('organization_members')
    .select('org_id, role')
    .eq('user_id', user.id)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  // 2. Owner-only gate — only org owners can enable features
  if (membership.role !== 'owner') {
    return NextResponse.json(
      { error: 'Only the account owner can activate RepuGuard.' },
      { status: 403 }
    )
  }

  const orgId = membership.org_id as string

  // 3. Check org exists and RepuGuard is not already active
  const { data: org } = await admin
    .from('organizations')
    .select('repuguard_status')
    .eq('id', orgId)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  if (org.repuguard_status === 'active') {
    return NextResponse.json({ error: 'RepuGuard is already active.' }, { status: 409 })
  }

  // 4. Require active OwnerRez connection (RepuGuard is OR-exclusive)
  const { data: connection } = await admin
    .from('integration_connections')
    .select('user_id')
    .eq('user_id', user.id)
    .eq('provider_id', 'ownerrez')
    .eq('status', 'active')
    .single()

  if (!connection) {
    return NextResponse.json(
      { error: 'An active OwnerRez connection is required to use RepuGuard.' },
      { status: 400 }
    )
  }

  // 5. Activate — set status to active, no Stripe sub, no trial dates
  const { error: updateErr } = await admin
    .from('organizations')
    .update({ repuguard_status: 'active' })
    .eq('id', orgId)

  if (updateErr) {
    console.error('[RepuGuard:activate] DB update failed:', updateErr)
    return NextResponse.json({ error: 'Failed to activate RepuGuard' }, { status: 500 })
  }

  await inngest.send({
    name: 'repuguard/activated',
    data: { org_id: orgId },
  })

  await logAuditEvent({
    orgId:    orgId,
    actorId:  user.id,
    action:   'repuguard.activated',
    metadata: { method: 'ownerrez_bundled' },
  })

  return NextResponse.json({ ok: true })
}
