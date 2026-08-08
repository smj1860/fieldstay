import { inngest }                from '@/lib/inngest/client'
import { createServiceClient }   from '@/lib/supabase/server'
import { resend, FROM }          from '@/lib/resend/client'
import { renderTrialExpiringEmail } from '@/emails/trial-expiring'
import { renderTrialExpiredEmail }  from '@/emails/trial-expired'
import { resolveEmailAudience, commercialPostalAddress } from '@/lib/email/unsubscribe'
import { tryUnwrap, unwrap } from '@/lib/supabase/unwrap'

/**
 * Has this org stopped being a trial? If so the rest of the sequence must not
 * run — every remaining message is written for someone who never converted.
 *
 * Two things this deliberately does NOT do, both of which it used to:
 *
 * 1. It does not discard the read error. The three call sites were
 *    `const { data: org } = await ...` followed by `org?.plan_status ===
 *    'active'`, so a read failure produced `false` — indistinguishable from
 *    "still trialing" — and the sequence marched on. The failure direction is
 *    the customer-hostile one: a Supabase blip during the day-14 check emails
 *    a PAYING customer "Your FieldStay trial has ended", and three days later
 *    "I'm truly sorry FieldStay wasn't the right fit for you." Throwing lets
 *    Inngest retry the step instead.
 *
 * 2. It does not ask `plan_status === 'active'`. Non-continuation is the
 *    safe default, so the test is "still trialing", not "successfully
 *    converted". `past_due` is a converted customer whose card declined —
 *    core-billing's dunning owns them, and they stay inside the app (see
 *    app/(dashboard)/layout.tsx's past-due banner, not the billing wall), so
 *    a churn-feedback email is both wrong and simultaneous with a dunning
 *    one. `cancelled`/`paused` have already churned or paused deliberately.
 *    Only `trialing` should keep this sequence alive, and a status added
 *    later stops it rather than opting into it silently.
 *
 * A missing org row (deleted account) also stops the sequence — maybeSingle,
 * so that is a null row rather than the PGRST116 that .single() would raise.
 */
async function hasLeftTrial(orgId: string): Promise<boolean> {
  const supabase = createServiceClient({ system: 'inngest:email-trial-lifecycle' })
  const res = await supabase
    .from('organizations')
    .select('plan_status')
    .eq('id', orgId)
    .maybeSingle()

  const org = unwrap(res, { site: 'inngest.email-trial-lifecycle.plan-status', orgId })

  return org?.plan_status !== 'trialing'
}

export const handleTrialLifecycle = inngest.createFunction(
  {
    id:      'email-trial-lifecycle',
    name:    'Trial Lifecycle Emails',
    retries: 2,
    // Prevent duplicate sequences per org
    concurrency: { key: 'event.data.org_id', limit: 1 },
  },
  { event: 'billing/trial-lifecycle-start' },
  async ({ event, step }) => {
    const { org_id, user_id, user_email, first_name, org_name, trial_ends_at } = event.data
    const appUrl   = process.env.NEXT_PUBLIC_APP_URL!
    const trialEnd = new Date(trial_ends_at)

    // ── Day 11: 3-day warning ─────────────────────────────────────────────
    const warnAt = new Date(trialEnd.getTime() - 3 * 24 * 60 * 60 * 1000)
    await step.sleepUntil('sleep-until-warning', warnAt)

    // Left the trial (converted, churned, or paused)? Cancel the sequence.
    const leftBeforeWarning = await step.run('check-subscription-before-warning', () => hasLeftTrial(org_id))

    if (leftBeforeWarning) return { cancelled: true, reason: 'subscribed-before-warning' }

    await step.run('send-trial-expiring-email', async () => {
      const supabase = createServiceClient({ system: 'inngest:email-trial-lifecycle' })

      const integrationRes = await supabase
        .from('integration_connections')
        .select('id')
        .eq('org_id', org_id)
        .eq('provider_id', 'ownerrez')
        .maybeSingle()
      const integrationOut = tryUnwrap(integrationRes, {
        site:  'inngest.email-trial-lifecycle.send-trial-expiring-email',
        orgId: org_id,
      })
      const integration = integrationOut.ok ? integrationOut.data : null

      const { count: propertyCount } = await supabase
        .from('properties')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org_id)
        .eq('is_active', true)

      const html = await renderTrialExpiringEmail({
        firstName:         first_name,
        orgName:           org_name,
        trialEndDate:      trialEnd.toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric',
        }),
        propertyCount:     propertyCount ?? 0,
        ownerRezConnected: !!integration,
        subscribeUrl:      `${appUrl}/settings?tab=billing`,
      })

      await resend.emails.send(
        {
          from:     FROM,
          to:       user_email,
          replyTo:  'stephen@fieldstay.app',
          subject:  'Your FieldStay trial ends in 3 days',
          html,
        },
        { idempotencyKey: `trial-expiring-${org_id}` }
      )
    })

    // ── Day 14 + 2h: Trial expired ────────────────────────────────────────
    const expiredAt = new Date(trialEnd.getTime() + 2 * 60 * 60 * 1000)
    await step.sleepUntil('sleep-until-expired', expiredAt)

    const leftBeforeExpiry = await step.run('check-subscription-at-expiry', () => hasLeftTrial(org_id))

    if (leftBeforeExpiry) return { cancelled: true, reason: 'subscribed-before-expiry' }

    await step.run('send-trial-expired-email', async () => {
      const dataExpires = new Date(trialEnd.getTime() + 30 * 24 * 60 * 60 * 1000)

      const html = await renderTrialExpiredEmail({
        firstName:       first_name,
        orgName:         org_name,
        reactivateUrl:   `${appUrl}/billing-wall`,
        dataExpiresDate: dataExpires.toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric',
        }),
      })

      await resend.emails.send(
        {
          from:     FROM,
          to:       user_email,
          replyTo:  'stephen@fieldstay.app',
          subject:  'Your FieldStay trial has ended',
          html,
        },
        { idempotencyKey: `trial-expired-${org_id}` }
      )
    })

    // ── Day 17: Churn feedback ────────────────────────────────────────────
    await step.sleep('sleep-before-churn-email', '3 days')

    const leftLate = await step.run('check-subscription-before-churn', () => hasLeftTrial(org_id))

    if (leftLate) return { cancelled: true, reason: 'subscribed-late' }

    // The two emails above are transactional/relationship messages — they are
    // about the status of an existing subscription, which CAN-SPAM exempts
    // from the opt-out requirement, and suppressing them would withhold
    // billing information the account holder needs.
    //
    // This one is different: its P.S. links to /billing-wall to win the
    // customer back, which is promotional content, so it is treated as
    // commercial and carries a real opt-out.
    const churnAudience = await step.run('check-churn-suppression', async () => {
      if (!user_id) return null
      const supabase = createServiceClient({ system: 'inngest:email-trial-lifecycle' })
      return resolveEmailAudience(supabase, user_id)
    })

    // No user_id (an event queued before user_id was added to this event's
    // payload) means the opt-out link cannot be built — so this does not send.
    // Skipping a win-back email is strictly better than sending a commercial
    // message with no way to unsubscribe.
    if (!churnAudience || churnAudience.suppressed) {
      return { cancelled: true, reason: 'churn-feedback-suppressed' }
    }

    await step.run('send-churn-feedback-email', async () => {
      // Plain text — intentionally NOT a React Email template, so the
      // CAN-SPAM footer is appended by hand rather than inherited from
      // EmailLayout.
      const postal = commercialPostalAddress()
      const postalBlock = postal ? `\n${postal}` : ''
      await resend.emails.send(
        {
          from:    'Stephen <stephen@fieldstay.app>',
          to:      user_email,
          subject: 'honest question',
          headers: churnAudience.headers,
          text: `Hi ${first_name},

I'm truly sorry FieldStay wasn't the right fit for you at this time.

I'm not reaching out to sell you on coming back. I genuinely want to know what we could have done better or what feature we were missing — that's it.

No follow-ups after this. No sales pitch. I just want to build the best product I can and your answer helps me do that.

— Stephen

P.S. If you ever want to give us another shot, your data stays for 30 days. ${appUrl}/billing-wall

---
Unsubscribe from FieldStay marketing email: ${churnAudience.unsubscribeUrl}${postalBlock}`,
        },
        { idempotencyKey: `trial-churn-feedback-${org_id}` }
      )
    })
  }
)
