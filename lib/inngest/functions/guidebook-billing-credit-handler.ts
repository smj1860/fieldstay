import { inngest } from '@/lib/inngest/client'
import { getActiveSponsorCount, resolvePlanCredit } from '@/lib/guidebook/helpers'
import { stripe } from '@/lib/stripe/client'
import { logAuditEvent } from '@/lib/audit'

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

    const posted = await step.run('post-plan-credit', async () => {
      const reason =
        activeSponsorCount >= 6
          ? '6_sponsor_reward'
          : '5_sponsor_reward'
      const creditLabel =
        activeSponsorCount >= 6
          ? '6-Sponsor Reward — $25 off your FieldStay plan'
          : '5-Sponsor Reward — $10 off your FieldStay plan'

      // Idempotency key is stable across retries: org + billing cycle period end.
      //
      // It is also stable across SEPARATE dispatches, which matters here.
      // guidebook-daily-monitor runs daily and dispatches whenever the
      // subscription renews within 48 hours, so a given period is normally
      // evaluated on two consecutive days. Same key, same amount → Stripe
      // returns the original invoice item and nothing is double-credited.
      //
      // But the sponsor count can CHANGE between those two days. Crossing the
      // 5 → 6 threshold sends the same key with a different amount, and Stripe
      // rejects that outright rather than ignoring it — so what should be good
      // news (the org earned a bigger reward) surfaced as a hard function
      // failure, with the smaller credit already posted and the run alerting.
      //
      // The first evaluation in the renewal window wins, deliberately: the
      // credit is already on the upcoming invoice, and the alternative — a
      // key that varies with the amount — would post a SECOND invoice item
      // and double-credit the org. Treat the collision as the no-op it is.
      try {
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
      } catch (err) {
        const isIdempotencyReplay =
          typeof err === 'object' && err !== null &&
          (err as { type?: string }).type === 'idempotency_error'

        if (!isIdempotencyReplay) throw err

        console.warn(
          `[guidebook-credit] org ${orgId} re-evaluated at a different sponsor tier ` +
          `for period ${currentPeriodEnd} — keeping the credit already posted`
        )
        return false
      }

      // Only audit-logged on the run that actually created the invoice item —
      // a collision means the ledger entry already exists from the first
      // evaluation, and a second one would claim a credit that was never posted.
      await logAuditEvent({
        orgId,
        action:     'billing.plan_credit.applied',
        targetType: 'organization',
        metadata:   { reason },
      })

      return true
    })

    if (!posted) {
      return { skipped: true, reason: 'credit_already_posted_this_period', activeSponsorCount }
    }

    return { orgId, activeSponsorCount, planCreditCents }
  }
)
