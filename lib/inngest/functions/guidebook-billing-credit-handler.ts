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
      return { skipped: true, reason: 'no_active_sponsors', activeSponsorCount }
    }

    const posted = await step.run('post-plan-credit', async () => {
      // No tiers left to branch on — the credit is the sponsor count times a
      // flat rate, so the label states the count and the amount it earned.
      const reason      = 'per_sponsor_credit'
      const creditLabel =
        `${activeSponsorCount} Sponsor${activeSponsorCount === 1 ? '' : 's'} — ` +
        `$${(planCreditCents / 100).toFixed(0)} off your FieldStay plan`

      // Idempotency key is stable across retries: org + billing cycle period end.
      //
      // It is also stable across SEPARATE dispatches, which matters here.
      // guidebook-daily-monitor runs daily and dispatches whenever the
      // subscription renews within 48 hours, so a given period is normally
      // evaluated on two consecutive days. Same key, same amount → Stripe
      // returns the original invoice item and nothing is double-credited.
      //
      // But the sponsor count can CHANGE between those two days, and the same
      // key with a different amount is something Stripe rejects outright
      // rather than ignoring.
      //
      // UNDER PER-SPONSOR CREDIT THIS PATH IS ROUTINE, NOT EXCEPTIONAL. It used
      // to need the org to cross 5 → 6 inside a 48-hour window, which is rare.
      // Now ANY sponsor added or cancelled in that window changes the amount,
      // so expect this collision in normal operation — it is not a symptom of
      // anything wrong.
      //
      // The first evaluation in the renewal window wins, deliberately: the
      // credit is already on the upcoming invoice, and the alternative — a
      // key that varies with the amount — would post a SECOND invoice item and
      // double-credit the org. Do NOT "fix" this by putting the amount in the
      // key. The new count applies from the next period; the worst case is a
      // host earning $5 one cycle later than they expected, which is not worth
      // a table of per-period dispatch state to avoid.
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

        // info, not warn: see the note above — this is now a normal operating
        // condition rather than an anomaly, and warning on it would train
        // whoever reads these logs to ignore them.
        console.info(
          `[guidebook-credit] org ${orgId} sponsor count changed inside the renewal ` +
          `window for period ${currentPeriodEnd} — the first evaluation's amount ` +
          `stands for this period; the new count applies next period`
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
        // Records what the credit was actually computed FROM, not just that
        // one happened — with a flat rate the count is the whole story.
        metadata:   { reason, activeSponsorCount, planCreditCents },
      })

      return true
    })

    if (!posted) {
      return { skipped: true, reason: 'credit_already_posted_this_period', activeSponsorCount }
    }

    return { orgId, activeSponsorCount, planCreditCents }
  }
)
