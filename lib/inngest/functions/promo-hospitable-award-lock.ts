import { NonRetriableError } from 'inngest'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe, PLANS, type PlanKey } from '@/lib/stripe/client'
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
      const unitAmount = subscription.items.data[0]?.price?.unit_amount
      if (unitAmount == null) {
        throw new Error(`Could not resolve unit_amount for subscription ${orgBilling.stripe_subscription_id}`)
      }
      return unitAmount
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

      await sendHospitablePriceLockEmail({
        toEmail:          orgBilling.billing_email,
        organizationName: orgBilling.name,
        sequenceNumber:   result.sequence_number,
        lockYears:        result.lock_years!,
        lockedTierName:   PLANS[orgBilling.plan as PlanKey]?.name ?? orgBilling.plan,
        lockedPriceCents: priceCents,
      })

      const supabase = createServiceClient({ system: 'inngest:promo-hospitable-award-price-lock' })
      await supabase
        .from('hospitable_launch_promo')
        .update({ congrats_email_sent_at: new Date().toISOString() })
        .eq('org_id', org_id)
    })

    return {
      org_id,
      status:         'awarded' as const,
      sequenceNumber: result.sequence_number,
      lockYears:      result.lock_years,
    }
  }
)
