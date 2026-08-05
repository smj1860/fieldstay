import type Stripe from 'stripe'
import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'

/** Guidebook sponsor checked out (session.metadata.feature === 'guidebook_sponsor'). */
export async function handleSponsorCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  // Validated like the three handlers below, which all guard their ids. This
  // one asserted them away with `metadata!.x!` — and its caller (route.ts)
  // branches on metadata.feature ALONE, so a session tagged guidebook_sponsor
  // with a missing sponsor id dispatched `sponsorId: undefined` under a
  // `string` schema. EventSchemas is compile-time only and does not catch it,
  // so the undefined reached the Inngest function. `session.subscription` has
  // the same problem: it is null for a non-subscription checkout.
  const sponsorId      = session.metadata?.guidebook_sponsor_id
  const orgId          = session.metadata?.org_id
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null
  const customerId     = typeof session.customer === 'string' ? session.customer : null

  if (!sponsorId || !orgId || !subscriptionId || !customerId) {
    reportError(new Error('Sponsor checkout session missing required fields'), {
      site:  'webhook.stripe.sponsor-checkout-incomplete',
      extra: {
        stripe_session_id: session.id,
        has_sponsor_id:    Boolean(sponsorId),
        has_org_id:        Boolean(orgId),
        has_subscription:  Boolean(subscriptionId),
        has_customer:      Boolean(customerId),
      },
    })
    return
  }

  await inngest.send({
    name: 'guidebook/sponsor.checkout.completed',
    data: { checkoutSessionId: session.id, sponsorId, orgId, subscriptionId, customerId },
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
