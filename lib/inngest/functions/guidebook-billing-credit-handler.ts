import { inngest } from '@/lib/inngest/client'
import { getActiveSponsorCount, resolvePlanCredit } from '@/lib/guidebook/helpers'
import { CREDIT_PER_SPONSOR_CENTS } from '@/lib/guidebook/sponsor-economics'
import { stripe } from '@/lib/stripe/client'
import { annualCostCents, monthlyCostCents } from '@/lib/stripe/brackets'
import { logAuditEvent } from '@/lib/audit'

export const guidebookBillingCreditHandler = inngest.createFunction(
  {
    id:   'guidebook-billing-credit-handler',
    name: 'Guidebook: Apply Plan Credit',
  },
  { event: 'guidebook/billing.credit.evaluate' },
  async ({ event, step }) => {
    const { orgId, stripeCustomerId, currentPeriodEnd, stripeSubscriptionId } = event.data

    const activeSponsorCount = await step.run('count-active-sponsors', async () => {
      return getActiveSponsorCount(orgId)
    })

    // ── The cap ──────────────────────────────────────────────────────────
    //
    // Sponsors are unbounded since
    // 20260909234738_uncap_guidebook_sponsor_slots.sql, so the credit is
    // limited by what the org actually pays instead. resolvePlanCredit()
    // requires this rather than defaulting it — see its docstring for why the
    // cap is mandatory the moment the 6-sponsor ceiling went.
    //
    // Derived from the subscription's QUANTITY through lib/stripe/brackets.ts,
    // not from the Price object: FieldStay's platform Price is tiered, so it
    // carries no `unit_amount` to read (the same trap
    // promo-hospitable-award-lock.ts documents). Not from invoice lines
    // either — those would have to exclude `invoiceitem` entries or
    // double-count a credit already posted this period.
    const planCostCents = await step.run('resolve-plan-cost', async () => {
      const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId)
      const item = subscription.items.data[0]
      const quantity = item?.quantity

      if (quantity == null) return null

      // The bill being capped against is the one for THIS period, so an
      // annual subscription caps against the annual figure.
      const isAnnual = item.price?.recurring?.interval === 'year'
      return isAnnual ? annualCostCents(quantity) : monthlyCostCents(quantity)
    })

    if (planCostCents == null) {
      // Outside the published schedule (Enterprise, a grandfathered or
      // dashboard-created price) or a subscription we could not read. There is
      // no trustworthy cap, so post nothing: an over-credit is money out the
      // door, a skipped cycle is recoverable.
      return { skipped: true, reason: 'plan_cost_unresolved', activeSponsorCount }
    }

    const planCreditCents = resolvePlanCredit(activeSponsorCount, planCostCents)

    if (planCreditCents === 0) {
      return { skipped: true, reason: 'no_active_sponsors', activeSponsorCount }
    }

    // What the sponsors earned before the cap. Compared against what is
    // actually being posted to tell whether the cap bound — the rate comes
    // from the shared constant rather than a literal, so a rate change cannot
    // silently make this comparison wrong.
    const earnedCents = activeSponsorCount * CREDIT_PER_SPONSOR_CENTS
    const capped      = earnedCents > planCreditCents

    const posted = await step.run('post-plan-credit', async () => {
      // No tiers left to branch on — the credit is the sponsor count times a
      // flat rate, limited by the plan cost. The label states the count and
      // either what it earned or that the plan is fully covered.
      const reason      = capped ? 'per_sponsor_credit_capped' : 'per_sponsor_credit'
      // When the cap binds, the label says so. A host who signed 40 sponsors
      // and sees "40 Sponsors — $98 off" with no explanation reads it as a
      // billing bug; naming it as the plan being fully covered is the same
      // number told truthfully.
      const plural  = activeSponsorCount === 1 ? '' : 's'
      const dollars = (planCreditCents / 100).toFixed(0)
      const creditLabel = capped
        ? `${activeSponsorCount} Sponsor${plural} — your full plan covered ($${dollars})`
        : `${activeSponsorCount} Sponsor${plural} — $${dollars} off your FieldStay plan`

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
        // Records what the credit was computed FROM, not just that one
        // happened: with a cap in play the count alone no longer explains the
        // amount, so the pre-cap figure and the cap itself are both kept.
        // These are plan-level figures, not customer financial detail — no
        // invoice ids, no payment instruments.
        metadata:   { reason, activeSponsorCount, earnedCents, planCreditCents, planCostCents, capped },
      })

      return true
    })

    if (!posted) {
      return { skipped: true, reason: 'credit_already_posted_this_period', activeSponsorCount }
    }

    return { orgId, activeSponsorCount, planCreditCents, planCostCents, capped }
  }
)
