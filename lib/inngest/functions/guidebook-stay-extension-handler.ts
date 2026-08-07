import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrap }              from '@/lib/supabase/unwrap'
import { sendSMS, normalizePhoneToE164 } from '@/lib/sms/telnyx'
import { renderSmsBody }       from '@/lib/sms/templates'
import { getPmEmails, getPmMembers } from '@/lib/inngest/helpers'
import { reportError }         from '@/lib/observability/report-error'

/** Minimal shape of the service client, enough for the claim-release helper. */
type ClaimClient = ReturnType<typeof createServiceClient>

/**
 * Releases a one-shot send claim (`sms_sent_at` / `pm_notified_at`) so a later
 * run can try again.
 *
 * Both call sites need this for two OPPOSITE reasons, and the second one was
 * missing entirely:
 *
 *  - `sendSMS` returns `{sent:false}` only for a DELIBERATE skip — SMS_ENABLED
 *    off, the daily nudge budget, demo-org suppression. Release so the send can
 *    happen once the skip no longer applies, then end cleanly; a retry cannot
 *    change an env var.
 *  - `sendSMS` THROWS on a real failure (dispatchToTelnyx throws on a timeout
 *    or any non-2xx). That throw escaped the step with the claim still held, so
 *    the Inngest retry hit `.is('<column>', null)`, matched zero rows, and
 *    returned `already_sent` — reporting success for a message nobody ever
 *    received, and never trying again.
 *
 * The release's own result was also discarded. A failed release leaves the
 * claim held forever with no signal anywhere, which is the same silent dead end
 * by a slower route.
 */
async function releaseSendClaim(
  supabase: ClaimClient,
  requestId: string,
  column: 'sms_sent_at' | 'pm_notified_at',
  orgId: string,
): Promise<void> {
  // Spelled out rather than computed: a `{ [column]: null }` payload widens to
  // an index signature the generated table types reject, and casting past that
  // would also cast away the protection against naming a column that isn't
  // there.
  const patch = column === 'sms_sent_at'
    ? { sms_sent_at: null }
    : { pm_notified_at: null }

  const { error } = await supabase
    .from('stay_extension_requests')
    .update(patch)
    .eq('id', requestId)
    .eq('org_id', orgId)

  if (error) {
    console.error(`[guidebook-stay-extension-handler] ${column} claim release failed`, error.message)
    reportError(error, {
      site:  'inngest.guidebook-stay-extension-handler.claim-release',
      orgId,
      extra: { column },
    })
  }
}

export const guidebookStayExtensionHandler = inngest.createFunction(
  { id: 'guidebook-stay-extension-handler', name: 'Guidebook: Stay Extension Notify' },
  { event: 'guidebook/stay.extension.request' },
  async ({ event, step }) => {
    const {
      requestId, orgId, bookingId, propertyId,
      gapDays, discountPct,
      guestPhoneE164, contactMethod,
    } = event.data

    // Fetch property and booking context.
    //
    // Both errors used to be discarded. A failed read left `booking` null, so
    // `portalUrl` was null, so the ENTIRE guest-SMS block below was skipped
    // silently — the gap-night offer this whole function exists to send was
    // never sent — while the PM email went out reading "checks out on
    // undefined". The step returned successfully either way, so Inngest never
    // retried it and nothing was logged. Throwing is what makes the retry
    // happen.
    const { property, booking } = await step.run('fetch-context', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-stay-extension-handler' })
      const [propRes, bookRes] = await Promise.all([
        supabase
          .from('properties')
          .select('name')
          .eq('id', propertyId)
          .eq('org_id', orgId)
          .single(),
        supabase
          .from('bookings')
          .select('guidebook_token, checkout_date')
          .eq('id', bookingId)
          .eq('org_id', orgId)
          .single(),
      ])
      return {
        property: unwrap(propRes, { site: 'inngest.guidebook-stay-extension-handler.property', orgId }),
        booking:  unwrap(bookRes, { site: 'inngest.guidebook-stay-extension-handler.booking',  orgId }),
      }
    })

    const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
    const portalUrl = booking?.guidebook_token
      ? `${appUrl}/g/b/${booking.guidebook_token}`
      : null

    // ── SMS to guest (if opted in) ────────────────────────────────────
    if (guestPhoneE164 && portalUrl) {
      await step.run('send-guest-sms', async () => {
        const supabase = createServiceClient({ system: 'inngest:guidebook-stay-extension-handler' })

        // Re-check consent at send time, not just when the triggering cron
        // computed eligibility — this handler runs off a queued event and
        // can execute an arbitrary amount of time later, wide enough for a
        // guest to have texted STOP in between. Every other guest SMS path
        // re-checks immediately before sending; this one didn't.
        //
        // Unwrapped, not destructured: a failed consent read must NOT be read
        // as "no consent". Both readings skip the send, but only one of them
        // should do so silently and permanently — the other needs a retry.
        const optinRes = await supabase
          .from('guidebook_guest_sms_optins')
          .select('is_active')
          .eq('booking_id', bookingId)
          .maybeSingle()

        const optin = unwrap(optinRes, {
          site: 'inngest.guidebook-stay-extension-handler.optin-recheck',
          orgId,
        })

        if (!optin?.is_active) return { skipped: 'not_opted_in' }

        // ── Atomic claim — wins the race, prevents double-send on retry ───────
        // UPDATE only succeeds if sms_sent_at IS NULL. If this step is retried
        // after a successful SMS send, the timestamp is already set, the
        // UPDATE affects 0 rows, and we skip the send. Mirrors the pattern in
        // guidebook-guest-opted-in.ts — including the part that file learned
        // and this one hadn't: a FAILED claim also returns null, which read as
        // "already sent" and skipped forever. Throwing lets Inngest retry.
        const claimRes = await supabase
          .from('stay_extension_requests')
          .update({ sms_sent_at: new Date().toISOString() })
          .eq('id', requestId)
          .eq('org_id', orgId)
          .is('sms_sent_at', null)
          .select('id')
          .maybeSingle()

        const claimed = unwrap(claimRes, {
          site: 'inngest.guidebook-stay-extension-handler.guest-sms-claim',
          orgId,
        })

        if (!claimed) return { skipped: 'already_sent' }

        const discountLine = discountPct
          ? ` We're offering ${discountPct}% off to extend your stay.`
          : ''

        const text = await renderSmsBody(orgId, 'stay_extension', {
          property_name:  property?.name ?? 'your stay',
          checkout_date:  booking?.checkout_date ?? '',
          portal_url:     portalUrl,
          discount_line:  discountLine,
        })

        // 'nudge': guest marketing message — counts against the platform-wide
        // daily SMS budget (the PM notification below is operational and doesn't)
        // See releaseSendClaim() for why both exits below release the claim.
        let result
        try {
          result = await sendSMS(guestPhoneE164, text, { category: 'nudge', orgId })
        } catch (err) {
          await releaseSendClaim(supabase, requestId, 'sms_sent_at', orgId)
          throw err
        }

        if (!result.sent) {
          await releaseSendClaim(supabase, requestId, 'sms_sent_at', orgId)
          return { skipped: result.reason ?? 'not_sent' }
        }

        return { sent: true }
      })
    }

    // ── Notify PM — respects the org's guidebook config contact method ────
    // 'ownerrez_url'  → guest self-serves directly to the PM's OwnerRez
    //                   booking page; nothing for FieldStay to notify.
    // 'email'         → existing behavior, via resend.
    // 'sms'           → Telnyx to the PM's own phone number, not the guest's.
    if (contactMethod !== 'ownerrez_url') {
      const propName = property?.name ?? 'your property'
      const discountLine = discountPct ? ` (${discountPct}% discount offered)` : ''

      if (contactMethod === 'sms') {
        await step.run('notify-pm-sms', async () => {
          const supabase = createServiceClient({ system: 'inngest:guidebook-stay-extension-handler' })
          const [pmMember] = await getPmMembers(supabase, orgId, { limit: 1 })
          if (!pmMember) return { skipped: true }

          // maybeSingle, not single: a PM with no profile row is a legitimate
          // skip, and .single() turns that into a PGRST116 error that unwrap
          // would now escalate into a retried failure.
          const profileRes = await supabase
            .from('profiles')
            .select('phone')
            .eq('id', pmMember.userId)
            .maybeSingle()

          const profile = unwrap(profileRes, {
            site: 'inngest.guidebook-stay-extension-handler.pm-profile',
            orgId,
          })

          if (!profile?.phone) return { skipped: true, reason: 'no_pm_phone' }

          const e164 = normalizePhoneToE164(profile.phone)
          if (!e164) return { skipped: true, reason: 'invalid_pm_phone' }

          // Atomic claim — Telnyx has no idempotency-key mechanism (unlike
          // Resend), so this mirrors the guest-SMS claim above: only the
          // caller that wins the UPDATE sends. A retry after a successful
          // send finds pm_notified_at already set and skips, instead of
          // texting the PM's own phone twice.
          // Unwrapped for the same reason as the guest claim above: a failed
          // claim also returns null, and reading that as "already notified"
          // drops the notification permanently.
          const claimRes = await supabase
            .from('stay_extension_requests')
            .update({ pm_notified_at: new Date().toISOString() })
            .eq('id', requestId)
            .eq('org_id', orgId)
            .is('pm_notified_at', null)
            .select('id')
            .maybeSingle()

          const claimed = unwrap(claimRes, {
            site: 'inngest.guidebook-stay-extension-handler.pm-sms-claim',
            orgId,
          })

          if (!claimed) return { skipped: true, reason: 'already_notified' }

          const text =
            `Stay extension opportunity — ${propName}: guest checks out ` +
            `${booking?.checkout_date}, ${gapDays} day${gapDays !== 1 ? 's' : ''} ` +
            `before next booking.${discountLine} Guest was messaged via the guidebook.`

          // See releaseSendClaim() — same two exits as the guest send above.
          let result
          try {
            result = await sendSMS(e164, text, { orgId })
          } catch (err) {
            await releaseSendClaim(supabase, requestId, 'pm_notified_at', orgId)
            throw err
          }

          if (!result.sent) {
            await releaseSendClaim(supabase, requestId, 'pm_notified_at', orgId)
            return { notified: false, skipped: result.reason ?? 'not_sent' }
          }

          return { notified: true }
        })
      } else {
        // contactMethod === 'email' (also the fallback if null/unset)
        await step.run('notify-pm-email', async () => {
          const supabase = createServiceClient({ system: 'inngest:guidebook-stay-extension-handler' })
          const [pmEmail] = await getPmEmails(supabase, orgId, { limit: 1 })
          if (!pmEmail) return { skipped: true }

          const { resend, FROM } = await import('@/lib/resend/client')
          const { renderPmAlert } = await import('@/lib/resend/emails/pm-alert')

          const html = await renderPmAlert({
            heading:  'Stay Extension Opportunity',
            body:     `A guest at ${propName} checks out on ${booking?.checkout_date}. There are ${gapDays} days before the next booking.${discountLine} A message has been sent to the guest via the guidebook.`,
            details: [
              { label: 'Property',  value: propName },
              { label: 'Gap',       value: `${gapDays} day${gapDays !== 1 ? 's' : ''}` },
              { label: 'Checkout',  value: booking?.checkout_date ?? undefined },
            ],
            ctaLabel: 'View Dashboard →',
            ctaUrl:   `${appUrl}/maintenance`,
          })

          const { error } = await resend.emails.send(
            { from: FROM, to: pmEmail, subject: `Stay Extension Opportunity — ${propName}`, html },
            { idempotencyKey: `stay-extension-pm-${requestId}` }
          )
          if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`)

          // No claim needed on this path — Resend's idempotencyKey is what
          // prevents the double-send, so this write is only a record of it.
          // Its result was discarded entirely, which meant a failed write left
          // the request looking un-notified forever with nothing logged.
          const { error: stampError } = await supabase
            .from('stay_extension_requests')
            .update({ pm_notified_at: new Date().toISOString() })
            .eq('id', requestId)
            .eq('org_id', orgId)

          if (stampError) {
            console.error('[guidebook-stay-extension-handler] pm_notified_at stamp failed', stampError.message)
            reportError(stampError, {
              site:  'inngest.guidebook-stay-extension-handler.pm-email-stamp',
              orgId,
            })
          }

          return { notified: true }
        })
      }
    }

    return { requestId, smsSent: Boolean(guestPhoneE164), pmNotified: contactMethod !== 'ownerrez_url' }
  }
)
