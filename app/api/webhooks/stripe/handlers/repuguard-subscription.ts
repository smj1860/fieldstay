import type Stripe from 'stripe'
import { logAuditEvent } from '@/lib/audit'
import type { StripeSupabaseClient } from './types'

/** RepuGuard subscription created/updated (subscription.metadata.feature === 'repuguard'). */
export async function handleRepuguardSubscriptionUpdated(
  supabase: StripeSupabaseClient,
  subscription: Stripe.Subscription,
  eventType: string,
): Promise<void> {
  const orgId = subscription.metadata?.org_id
  if (!orgId) return

  const repuguardStatus =
    subscription.status === 'active'   ? 'active'
  : subscription.status === 'trialing' ? 'trial'
  : subscription.status === 'past_due' ? 'active'
  : 'cancelled'

  await supabase
    .from('organizations')
    .update({ repuguard_status: repuguardStatus })
    .eq('id', orgId)

  await logAuditEvent({
    orgId,
    action:     'billing.repuguard_subscription.updated',
    targetType: 'organization',
    targetId:   orgId,
    metadata:   { status: repuguardStatus, stripe_event_type: eventType },
  })
}

/** RepuGuard subscription cancelled. */
export async function handleRepuguardSubscriptionCancelled(
  supabase: StripeSupabaseClient,
  subscription: Stripe.Subscription,
  eventType: string,
): Promise<void> {
  const orgId = subscription.metadata?.org_id
  if (!orgId) return

  await supabase
    .from('organizations')
    .update({ repuguard_status: 'cancelled' })
    .eq('id', orgId)

  await logAuditEvent({
    orgId,
    action:     'billing.repuguard_subscription.updated',
    targetType: 'organization',
    targetId:   orgId,
    metadata:   { status: 'cancelled', stripe_event_type: eventType },
  })
}
