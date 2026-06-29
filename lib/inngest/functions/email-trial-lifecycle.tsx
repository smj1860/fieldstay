import { inngest }                from '@/lib/inngest/client'
import { createServiceClient }   from '@/lib/supabase/server'
import { resend, FROM }          from '@/lib/resend/client'
import { renderTrialExpiringEmail } from '@/emails/trial-expiring'
import { renderTrialExpiredEmail }  from '@/emails/trial-expired'

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
    const { org_id, user_email, first_name, org_name, trial_ends_at } = event.data
    const appUrl   = process.env.NEXT_PUBLIC_APP_URL!
    const trialEnd = new Date(trial_ends_at)

    // ── Day 11: 3-day warning ─────────────────────────────────────────────
    const warnAt = new Date(trialEnd.getTime() - 3 * 24 * 60 * 60 * 1000)
    await step.sleepUntil('sleep-until-warning', warnAt)

    // Check if they subscribed — if so, cancel the whole sequence
    const subscribed = await step.run('check-subscription-before-warning', async () => {
      const supabase = createServiceClient()
      const { data: org } = await supabase
        .from('organizations')
        .select('plan_status')
        .eq('id', org_id)
        .single()
      return org?.plan_status === 'active'
    })

    if (subscribed) return { cancelled: true, reason: 'subscribed-before-warning' }

    await step.run('send-trial-expiring-email', async () => {
      const supabase = createServiceClient()

      const { data: integration } = await supabase
        .from('integration_connections')
        .select('id')
        .eq('org_id', org_id)
        .eq('provider_id', 'ownerrez')
        .maybeSingle()

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

    const subscribedAfterWarning = await step.run('check-subscription-at-expiry', async () => {
      const supabase = createServiceClient()
      const { data: org } = await supabase
        .from('organizations')
        .select('plan_status')
        .eq('id', org_id)
        .single()
      return org?.plan_status === 'active'
    })

    if (subscribedAfterWarning) return { cancelled: true, reason: 'subscribed-before-expiry' }

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

    const subscribedLate = await step.run('check-subscription-before-churn', async () => {
      const supabase = createServiceClient()
      const { data: org } = await supabase
        .from('organizations')
        .select('plan_status')
        .eq('id', org_id)
        .single()
      return org?.plan_status === 'active'
    })

    if (subscribedLate) return { cancelled: true, reason: 'subscribed-late' }

    await step.run('send-churn-feedback-email', async () => {
      // Plain text — intentionally NOT a React Email template
      await resend.emails.send(
        {
          from:    'Stephen <stephen@fieldstay.app>',
          to:      user_email,
          subject: 'honest question',
          text: `Hi ${first_name},

I'm truly sorry FieldStay wasn't the right fit for you at this time.

I'm not reaching out to sell you on coming back. I genuinely want to know what we could have done better or what feature we were missing — that's it.

No follow-ups after this. No sales pitch. I just want to build the best product I can and your answer helps me do that.

— Stephen

P.S. If you ever want to give us another shot, your data stays for 30 days. ${appUrl}/billing-wall`,
        },
        { idempotencyKey: `trial-churn-feedback-${org_id}` }
      )
    })
  }
)
