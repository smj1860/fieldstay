import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { sendSMS }             from '@/lib/sms/telnyx'
import { renderSmsBody }       from '@/lib/sms/templates'
import { getPmEmails }         from '@/lib/inngest/helpers'

export const guidebookStayExtensionHandler = inngest.createFunction(
  { id: 'guidebook-stay-extension-handler', name: 'Guidebook: Stay Extension Notify' },
  { event: 'guidebook/stay.extension.request' },
  async ({ event, step }) => {
    const {
      requestId, orgId, bookingId, propertyId,
      gapDays, discountPct,
      guestPhoneE164,
    } = event.data

    // Fetch property and booking context
    const { property, booking } = await step.run('fetch-context', async () => {
      const supabase = createServiceClient()
      const [propRes, bookRes] = await Promise.all([
        supabase
          .from('properties')
          .select('name')
          .eq('id', propertyId)
          .single(),
        supabase
          .from('bookings')
          .select('guidebook_token, checkout_date')
          .eq('id', bookingId)
          .single(),
      ])
      return { property: propRes.data, booking: bookRes.data }
    })

    const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
    const portalUrl = booking?.guidebook_token
      ? `${appUrl}/g/b/${booking.guidebook_token}`
      : null

    // ── SMS to guest (if opted in) ────────────────────────────────────
    if (guestPhoneE164 && portalUrl) {
      await step.run('send-guest-sms', async () => {
        const supabase = createServiceClient()

        // Re-check consent at send time, not just when the triggering cron
        // computed eligibility — this handler runs off a queued event and
        // can execute an arbitrary amount of time later, wide enough for a
        // guest to have texted STOP in between. Every other guest SMS path
        // re-checks immediately before sending; this one didn't.
        const { data: optin } = await supabase
          .from('guidebook_guest_sms_optins')
          .select('is_active')
          .eq('booking_id', bookingId)
          .maybeSingle()

        if (!optin?.is_active) return

        // ── Atomic claim — wins the race, prevents double-send on retry ───────
        // UPDATE only succeeds if sms_sent_at IS NULL. If this step is retried
        // after a successful SMS send, the timestamp is already set, the
        // UPDATE affects 0 rows, and we skip the send. Mirrors the pattern in
        // guidebook-guest-opted-in.ts.
        const { data: claimed } = await supabase
          .from('stay_extension_requests')
          .update({ sms_sent_at: new Date().toISOString() })
          .eq('id', requestId)
          .is('sms_sent_at', null)
          .select('id')
          .maybeSingle()

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

        const result = await sendSMS(guestPhoneE164, text)

        if (!result.sent) {
          // SMS failed — roll back the claim so a retry can attempt again
          await supabase
            .from('stay_extension_requests')
            .update({ sms_sent_at: null })
            .eq('id', requestId)
        }
      })
    }

    // ── Notify PM ─────────────────────────────────────────────────────
    const pmEmail = await step.run('fetch-pm-email', async () => {
      const supabase = createServiceClient()
      const [email] = await getPmEmails(supabase, orgId); return email ?? null
    })

    if (pmEmail) {
      await step.run('notify-pm', async () => {
        const supabase = createServiceClient()
        const { resend, FROM } = await import('@/lib/resend/client')
        const { renderPmAlert } = await import('@/lib/resend/emails/pm-alert')

        const discountLine = discountPct ? ` (${discountPct}% discount offered)` : ''
        const propName     = property?.name ?? 'your property'

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
          {
            from:    FROM,
            to:      pmEmail,
            subject: `Stay Extension Opportunity — ${propName}`,
            html,
          },
          { idempotencyKey: `stay-extension-pm-${requestId}` }
        )

        if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`)

        await supabase
          .from('stay_extension_requests')
          .update({ pm_notified_at: new Date().toISOString() })
          .eq('id', requestId)
      })
    }

    return { requestId, smsSent: Boolean(guestPhoneE164), pmNotified: Boolean(pmEmail) }
  }
)
