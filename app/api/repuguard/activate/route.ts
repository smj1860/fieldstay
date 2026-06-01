import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { inngest } from '@/lib/inngest/client'

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

  // Get org membership
  const { data: membership } = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const orgId = membership.org_id as string

  // Fetch org info
  const { data: org } = await admin
    .from('organizations')
    .select('repuguard_status, stripe_customer_id')
    .eq('id', orgId)
    .single()

  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  // Check not already active
  if (org.repuguard_status === 'trial' || org.repuguard_status === 'active') {
    return NextResponse.json({ error: 'RepuGuard already activated' }, { status: 409 })
  }

  // Verify active OwnerRez connection
  const { data: connection } = await admin
    .from('integration_connections')
    .select('user_id')
    .eq('user_id', user.id)
    .eq('provider_id', 'ownerrez')
    .eq('status', 'active')
    .single()

  if (!connection) {
    return NextResponse.json(
      { error: 'Active OwnerRez connection required to activate RepuGuard' },
      { status: 400 }
    )
  }

  // Determine if founding member (before Jan 1, 2027)
  const foundingCutoff = new Date('2027-01-01T00:00:00Z')
  const isFoundingMember = new Date() < foundingCutoff

  const priceId = isFoundingMember
    ? (process.env.REPUGUARD_FOUNDING_PRICE_ID ?? '')
    : (process.env.REPUGUARD_STANDARD_PRICE_ID ?? '')

  if (!priceId) {
    return NextResponse.json({ error: 'RepuGuard price not configured' }, { status: 500 })
  }

  // 90-day trial = 90 days from now
  const trialEnd = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60

  const customerId = org.stripe_customer_id as string | null
  if (!customerId) {
    return NextResponse.json({ error: 'No Stripe customer on file — complete checkout first' }, { status: 400 })
  }

  // Create Stripe subscription
  const subscription = await stripe.subscriptions.create({
    customer:        customerId,
    items:           [{ price: priceId }],
    trial_end:       trialEnd,
    metadata: {
      org_id:  orgId,
      feature: 'repuguard',
    },
  })

  const trialStartDate = new Date()
  const trialEndDate   = new Date(trialEnd * 1000)

  // Update org
  await admin
    .from('organizations')
    .update({
      repuguard_status:                'trial',
      repuguard_trial_start:           trialStartDate.toISOString(),
      repuguard_trial_end:             trialEndDate.toISOString(),
      repuguard_stripe_subscription_id: subscription.id,
      repuguard_founding_member:       isFoundingMember,
    })
    .eq('id', orgId)

  // Dispatch Inngest event
  await inngest.send({
    name: 'repuguard/activated',
    data: { org_id: orgId },
  })

  return NextResponse.json({ ok: true })
}
