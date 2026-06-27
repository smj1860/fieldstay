import { inngest } from '@/lib/inngest/client'
import { getActiveSponsorCount, resolvePlanCredit } from '@/lib/guidebook/helpers'
import { stripe } from '@/lib/stripe/client'

export const guidebookBillingCreditHandler = inngest.createFunction(
  {
    id:   'guidebook-billing-credit-handler',
    name: 'Guidebook: Apply Plan Credit',
  },
  { event: 'guidebook/billing.credit.evaluate' },
  async ({ event, step }) => {
    const { orgId, stripeCustomerId, currentPeriodEnd } = event.data

    const activeSponsorCount = await step.run('count-active-sponsors', async () => {
      return getActiveSponsorCount(orgId)
    })

    const planCreditCents = resolvePlanCredit(activeSponsorCount)

    if (planCreditCents === 0) {
      return { skipped: true, reason: 'below_credit_threshold', activeSponsorCount }
    }

    await step.run('post-plan-credit', async () => {
      const creditLabel =
        activeSponsorCount >= 6
          ? '6-Sponsor Reward — $25 off your FieldStay plan'
          : '5-Sponsor Reward — $10 off your FieldStay plan'

      // Idempotency key is stable across retries: org + billing cycle period end
      await stripe.invoiceItems.create(
        {
          customer:    stripeCustomerId,
          amount:      -planCreditCents,
          currency:    'usd',
          description: `FieldStay Guidebook Sponsor Reward: ${creditLabel}`,
        },
        {
          idempotencyKey: `guidebook-credit-${orgId}-${currentPeriodEnd}`,
        }
      )
    })

    return { orgId, activeSponsorCount, planCreditCents }
  }
)
