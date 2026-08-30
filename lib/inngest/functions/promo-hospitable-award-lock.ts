import { unwrap } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import { NonRetriableError } from 'inngest'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { monthlyCostCents } from '@/lib/stripe/brackets'
import { sendHospitablePriceLockEmail } from '@/lib/resend/client'
import { logAuditEvent } from '@/lib/audit'

/**
 * Awards the Hospitable launch promo price lock on the existing
 * billing/first-payment-confirmed event (trialing -> active transition) — no
 * changes to the Stripe webhook handler needed. claim_hospitable_promo_slot()
 * does the actual two-tier assignment; this function just resolves the
 * current subscription price, calls it, and sends the congrats email.
 *
 * Three independent safeguards against double-awarding a retried delivery:
 * 1. Inngest's own event/step memoization.
 * 2. This function's per-org `concurrency` key.
 * 3. The `already_awarded` check inside claim_hospitable_promo_slot itself.
 */
export const awardHospitablePriceLock = inngest.createFunction(
  {
    id:      'promo-hospitable-award-price-lock',
    name:    'Hospitable Promo: Award Price Lock',
    retries: 3,
    concurrency: {
      limit: 1,
      key:   'event.data.org_id',
    },
  },
  { event: 'billing/first-payment-confirmed' },
  async ({ event, step }) => {
    const { org_id } = event.data

    if (!org_id) {
      throw new NonRetriableError('Missing org_id in first-payment-confirmed event')
    }

    // billing/first-payment-confirmed fires for EVERY trial->paid conversion
    // on the platform, not just Hospitable ones — this cheap early exit skips
    // the Stripe API call and the claim RPC for the overwhelming majority of
    // conversions that were never tagged. claim_hospitable_promo_slot() would
    // reach the same not_eligible conclusion, just after doing unnecessary
    // work first.
    //
    // Which is exactly why a read error here must NOT be treated as
    // "untagged". This step is a pure optimization, and an optimization that
    // fails is only allowed to cost time — never to change the outcome. It
    // used to `return false` on error, and that quietly forfeited a real
    // customer's price lock: billing/first-payment-confirmed fires exactly
    // ONCE per org (the trialing -> active transition), so there is no second
    // delivery to recover on. A one-second Supabase blip at that instant was
    // the difference between a 2-year locked rate and nothing, recorded only
    // as a console.error.
    //
    // The old justification — "must never hold up the core billing event" —
    // was wrong on the facts. This is an independent Inngest consumer of a
    // fire-and-forget event (app/api/webhooks/stripe/handlers/core-billing.ts
    // has already returned by the time it runs); throwing or slowing down here
    // cannot delay the Stripe webhook, the subscription update, or the sibling
    // email-subscriber-checkin function.
    //
    // So `unknown` falls through to the full path and lets
    // claim_hospitable_promo_slot() — which re-reads the same row and returns
    // not_eligible for an untagged org — be the single authority. If the
    // outage is real rather than transient, the RPC step throws, Inngest
    // retries, and a terminal failure lands in Sentry via on-failure.ts.
    const tagState = await step.run('check-hospitable-tagged', async () => {
      const supabase = createServiceClient({ system: 'inngest:promo-hospitable-award-price-lock' })
      const { data, error } = await supabase
        .from('hospitable_launch_promo')
        .select('hospitable_tagged')
        .eq('org_id', org_id)
        .maybeSingle()

      if (error) {
        console.error(`[promo/hospitable] Failed to check tag status for org ${org_id}:`, error.message)
        return 'unknown' as const
      }

      return data?.hospitable_tagged === true ? ('tagged' as const) : ('untagged' as const)
    })

    if (tagState === 'untagged') {
      return { org_id, status: 'not_awarded' as const, reason: 'not_eligible' as const }
    }

    const orgBilling = await step.run('load-org-billing', async () => {
      const supabase = createServiceClient({ system: 'inngest:promo-hospitable-award-price-lock' })
      const { data: org, error } = await supabase
        .from('organizations')
        .select('id, name, billing_email, plan, stripe_subscription_id')
        .eq('id', org_id)
        .single()

      if (error || !org) {
        throw new Error(`Could not load org ${org_id} for price lock award: ${error?.message}`)
      }
      if (!org.stripe_subscription_id) {
        throw new NonRetriableError(`Org ${org_id} has no stripe_subscription_id — cannot price-lock`)
      }

      return org
    })

    const priceCents = await step.run('resolve-current-price', async () => {
      const subscription = await stripe.subscriptions.retrieve(orgBilling.stripe_subscription_id!)
      // The graduated platform price is billing_scheme: 'tiered', which never
      // sets a flat `unit_amount` on the Price object — the total is a
      // function of the subscription item's `quantity` run through the same
      // bracket schedule the Price's own tiers were built from
      // (lib/stripe/brackets.ts). This snapshot IS the org's current computed
      // monthly total, not a per-unit rate.
      const quantity = subscription.items.data[0]?.quantity
      if (quantity == null) {
        throw new Error(`Could not resolve quantity for subscription ${orgBilling.stripe_subscription_id}`)
      }
      const cents = monthlyCostCents(quantity)
      if (cents == null) {
        throw new Error(
          `Quantity ${quantity} for subscription ${orgBilling.stripe_subscription_id} ` +
          `is outside the self-serve pricing range — cannot compute a price-lock snapshot`,
        )
      }
      return cents
    })

    const result = await step.run('claim-promo-slot', async () => {
      const supabase = createServiceClient({ system: 'inngest:promo-hospitable-award-price-lock' })
      const { data, error } = await supabase
        .rpc('claim_hospitable_promo_slot', {
          p_org_id:     org_id,
          p_tier:       orgBilling.plan,
          p_price_cents: priceCents,
        })
        .single()

      if (error) {
        throw new Error(`claim_hospitable_promo_slot failed for org ${org_id}: ${error.message}`)
      }

      return data as {
        sequence_number: number | null
        already_awarded: boolean
        not_eligible:    boolean
        window_closed:   boolean
        lock_years:      1 | 2 | null
      }
    })

    if (result.already_awarded) {
      return { org_id, status: 'already_awarded' as const }
    }

    if (result.not_eligible) {
      return { org_id, status: 'not_awarded' as const, reason: 'not_eligible' as const }
    }

    if (result.window_closed) {
      return { org_id, status: 'not_awarded' as const, reason: 'window_closed' as const }
    }

    // Every remaining case is a real award — tier 1 (2-year, numbered) or
    // tier 2 (1-year, unnumbered).
    await step.run('log-award-audit-event', async () => {
      await logAuditEvent({
        orgId:      org_id,
        action:     'billing.hospitable_price_lock.awarded',
        targetType: 'organization',
        targetId:   org_id,
        metadata: {
          sequenceNumber: result.sequence_number,
          lockYears:      result.lock_years,
          tier:           orgBilling.plan,
        },
      })
    })

    await step.run('send-congrats-email', async () => {
      if (!orgBilling.billing_email) {
        throw new Error(`Org ${org_id} has no billing_email — cannot send price lock email`)
      }

      const supabase = createServiceClient({ system: 'inngest:promo-hospitable-award-price-lock' })

      // Check-before-send guard, same idiom as add-items-to-kroger-cart's
      // milestone check in build-shopping-cart.ts: a step that throws after
      // the external send succeeds re-runs its whole body on retry, so the
      // send itself must be guarded, not just split into a later step.
      // This read is the send-once guard. Discarding its error returned null,
      // which reads as "not sent yet" and sends the congrats email AGAIN.
      const existingRes = await supabase
        .from('hospitable_launch_promo')
        .select('congrats_email_sent_at')
        .eq('org_id', org_id)
        .maybeSingle()

      const existing = unwrap(existingRes, {
        site: 'inngest.promo-hospitable-award-lock.send-once-guard', orgId: org_id,
      })

      if (existing?.congrats_email_sent_at) return

      await sendHospitablePriceLockEmail({
        toEmail:          orgBilling.billing_email,
        organizationName: orgBilling.name,
        sequenceNumber:   result.sequence_number,
        lockYears:        result.lock_years!,
        // There is no discrete tier name any more (org.plan is 'platform' for
        // every self-serve org) — the email now names the RATES rather than a
        // tier, so this is a fixed label rather than a lookup.
        lockedTierName:   'FieldStay',
        lockedPriceCents: priceCents,
      })

      // Not thrown: the email above already sent successfully, and a step
      // retry from here would re-run the whole body and send it again (see
      // the send-once guard note above). Log + report instead so a failed
      // stamp is visible without risking a duplicate send.
      const { error: markSentError } = await supabase
        .from('hospitable_launch_promo')
        .update({ congrats_email_sent_at: new Date().toISOString() })
        .eq('org_id', org_id)

      if (markSentError) {
        console.error(`[promo/hospitable] Failed to mark congrats email sent for org ${org_id}:`, markSentError.message)
        reportError(markSentError, { site: 'inngest.promo-hospitable-award-lock.mark-email-sent', orgId: org_id })
      }
    })

    return {
      org_id,
      status:         'awarded' as const,
      sequenceNumber: result.sequence_number,
      lockYears:      result.lock_years,
    }
  }
)
