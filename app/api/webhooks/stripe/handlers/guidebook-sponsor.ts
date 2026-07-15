import type Stripe from 'stripe'
import { inngest } from '@/lib/inngest/client'

/** Guidebook sponsor checked out (session.metadata.feature === 'guidebook_sponsor'). */
export async function handleSponsorCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  await inngest.send({
    name: 'guidebook/sponsor.checkout.completed',
    data: {
      checkoutSessionId: session.id,
      sponsorId:         session.metadata!.guidebook_sponsor_id!,
      orgId:             session.metadata!.org_id!,
      subscriptionId:    session.subscription as string,
      customerId:        session.customer as string,
    },
  })
}

/** Guidebook sponsor's subscription was cancelled. */
export async function handleSponsorSubscriptionCancelled(subscription: Stripe.Subscription): Promise<void> {
  const orgId     = subscription.metadata?.org_id
  const sponsorId = subscription.metadata?.guidebook_sponsor_id
  if (!orgId || !sponsorId) return

  await inngest.send({
    name: 'guidebook/sponsor.subscription.cancelled',
    data: { subscriptionId: subscription.id, orgId, sponsorId },
  })
}

/** Guidebook sponsor's invoice payment failed. */
export async function handleSponsorPaymentFailed(subscription: Stripe.Subscription): Promise<void> {
  const orgId     = subscription.metadata?.org_id
  const sponsorId = subscription.metadata?.guidebook_sponsor_id
  if (!orgId || !sponsorId) return

  await inngest.send({
    name: 'guidebook/sponsor.payment.failed',
    data: { subscriptionId: subscription.id, orgId, sponsorId },
  })
}

/** Guidebook sponsor's invoice payment recovered after a prior failure. */
export async function handleSponsorPaymentRecovered(subscription: Stripe.Subscription): Promise<void> {
  const orgId     = subscription.metadata?.org_id
  const sponsorId = subscription.metadata?.guidebook_sponsor_id
  if (!orgId || !sponsorId) return

  await inngest.send({
    name: 'guidebook/sponsor.payment.recovered',
    data: { subscriptionId: subscription.id, orgId, sponsorId },
  })
}
