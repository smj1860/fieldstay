import { inngest }                from '@/lib/inngest/client'
import { createServiceClient }   from '@/lib/supabase/server'
import { resend, FROM }          from '@/lib/resend/client'
import { renderTrialExpiringEmail } from '@/emails/trial-expiring'
import { renderTrialExpiredEmail }  from '@/emails/trial-expired'
import { resolveEmailAudience, commercialPostalAddress } from '@/lib/email/unsubscribe'
import { tryUnwrap, unwrap } from '@/lib/supabase/unwrap'
import { PMS_PROVIDER_IDS, pmsDisplayName } from '@/lib/integrations/registry'
import {
  trialWarningAt, trialExpiredEmailAt, extendedTrialEnd, roundSuffix, MAX_TRIAL_EXTENSIONS,
} from '@/lib/billing/trial-schedule'

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

/**
 * The org's LIVE trial end, as stored right now (ISO string), or null.
 *
 * The event carries the end date as it was at signup. An extension moves the
 * column and nothing else, so the sequence asks the column each time it wakes.
 * Returns a string so the step result serialises through Inngest unchanged.
 */
async function liveTrialEnd(orgId: string): Promise<string | null> {
  const supabase = createServiceClient({ system: 'inngest:email-trial-lifecycle' })
  const res = await supabase
    .from('organizations')
    .select('trial_ends_at')
    .eq('id', orgId)
    .maybeSingle()

  const org = unwrap(res, { site: 'inngest.email-trial-lifecycle.trial-end', orgId })
  return org?.trial_ends_at ?? null
}

interface TrialEmailArgs {
  userEmail:      string
  firstName:      string
  orgName:        string
  /** The end date this round planned around, which is the date the email states. */
  trialEnd:       Date
  appUrl:         string
  idempotencyKey: string
}

async function sendTrialExpiringEmail(args: TrialEmailArgs & { orgId: string }): Promise<void> {
  const { orgId, userEmail, firstName, orgName, trialEnd, appUrl, idempotencyKey } = args
  const supabase = createServiceClient({ system: 'inngest:email-trial-lifecycle' })

  // ANY connected PMS, not just OwnerRez. This read used to be
  // `.eq('provider_id', 'ownerrez')`, so every Hospitable and Hostex org
  // was told in this email to go connect a PMS they had already connected
  // — and the copy named the wrong product while doing it. Ordered so the
  // name shown is deterministic when an org has connected two.
  const integrationRes = await supabase
    .from('integration_connections')
    .select('provider_id')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .in('provider_id', PMS_PROVIDER_IDS)
    .order('provider_id')
    .limit(1)
    .maybeSingle()
  const integrationOut = tryUnwrap(integrationRes, {
    site:  'inngest.email-trial-lifecycle.send-trial-expiring-email',
    orgId,
  })
  const connectedPmsName = integrationOut.ok && integrationOut.data
    ? pmsDisplayName(integrationOut.data.provider_id)
    : null

  const { count: propertyCount } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('is_active', true)

  const html = await renderTrialExpiringEmail({
    firstName,
    orgName,
    trialEndDate:      trialEnd.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    }),
    propertyCount:     propertyCount ?? 0,
    connectedPmsName,
    subscribeUrl:      `${appUrl}/settings?tab=billing`,
  })

  await resend.emails.send(
    {
      from:     FROM,
      to:       userEmail,
      replyTo:  'stephen@fieldstay.app',
      subject:  'Your FieldStay trial ends in 3 days',
      html,
    },
    { idempotencyKey }
  )
}

async function sendTrialExpiredEmail(args: TrialEmailArgs): Promise<void> {
  const { userEmail, firstName, orgName, trialEnd, appUrl, idempotencyKey } = args
  const dataExpires = new Date(trialEnd.getTime() + 30 * 24 * 60 * 60 * 1000)

  const html = await renderTrialExpiredEmail({
    firstName,
    orgName,
    reactivateUrl:   `${appUrl}/billing-wall`,
    dataExpiresDate: dataExpires.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    }),
  })

  await resend.emails.send(
    {
      from:     FROM,
      to:       userEmail,
      replyTo:  'stephen@fieldstay.app',
      subject:  'Your FieldStay trial has ended',
      html,
    },
    { idempotencyKey }
  )
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
    let trialEnd = new Date(trial_ends_at)

    // The first two phases repeat if the trial is EXTENDED while the sequence is
    // asleep: it re-reads the live end date each time it wakes and plans again
    // around the new one (see lib/billing/trial-schedule.ts). Round 0 uses the
    // original step ids and idempotency keys exactly, so sequences already
    // sleeping when this shipped replay against their recorded history.
    for (let round = 0; ; round++) {
      const sfx            = roundSuffix(round)
      const planned        = trialEnd
      const canReplan      = round < MAX_TRIAL_EXTENSIONS

      // ── Day 11: 3-day warning ───────────────────────────────────────────
      await step.sleepUntil(`sleep-until-warning${sfx}`, trialWarningAt(planned))

      // Left the trial (converted, churned, or paused)? Cancel the sequence.
      const leftBeforeWarning = await step.run(`check-subscription-before-warning${sfx}`, () => hasLeftTrial(org_id))

      if (leftBeforeWarning) return { cancelled: true, reason: 'subscribed-before-warning' }

      const liveAtWarning = await step.run(`check-extension-before-warning${sfx}`, () => liveTrialEnd(org_id))
      const movedAtWarning = canReplan ? extendedTrialEnd(planned, liveAtWarning) : null
      if (movedAtWarning) {
        trialEnd = movedAtWarning
        continue
      }

      await step.run(`send-trial-expiring-email${sfx}`, () => sendTrialExpiringEmail({
        orgId: org_id, userEmail: user_email, firstName: first_name, orgName: org_name,
        trialEnd: planned, appUrl, idempotencyKey: `trial-expiring-${org_id}${sfx}`,
      }))

      // ── Day 14 + 2h: Trial expired ──────────────────────────────────────
      await step.sleepUntil(`sleep-until-expired${sfx}`, trialExpiredEmailAt(planned))

      const leftBeforeExpiry = await step.run(`check-subscription-at-expiry${sfx}`, () => hasLeftTrial(org_id))

      if (leftBeforeExpiry) return { cancelled: true, reason: 'subscribed-before-expiry' }

      // The check that matters for an extension granted after the warning went
      // out: without it, the expiry email arrives on the OLD date.
      const liveAtExpiry = await step.run(`check-extension-at-expiry${sfx}`, () => liveTrialEnd(org_id))
      const movedAtExpiry = canReplan ? extendedTrialEnd(planned, liveAtExpiry) : null
      if (movedAtExpiry) {
        trialEnd = movedAtExpiry
        continue
      }

      await step.run(`send-trial-expired-email${sfx}`, () => sendTrialExpiredEmail({
        userEmail: user_email, firstName: first_name, orgName: org_name,
        trialEnd: planned, appUrl, idempotencyKey: `trial-expired-${org_id}${sfx}`,
      }))
      break
    }

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

I'm not reaching out to sell you on coming back. I genuinely want to know what we could have done better or what feature we were missing. That's it.

No follow-ups after this. No sales pitch. I just want to build the best product I can and your answer helps me do that.

Stephen

P.S. If you ever want to give us another shot, your data stays for 30 days. ${appUrl}/billing-wall

---
Unsubscribe from FieldStay marketing email: ${churnAudience.unsubscribeUrl}${postalBlock}`,
        },
        { idempotencyKey: `trial-churn-feedback-${org_id}` }
      )
    })
  }
)
