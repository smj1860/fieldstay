import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { Resend }               from 'resend'

export const notifyIntegrationError = inngest.createFunction(
  { id: 'notify-integration-error', name: 'Notify PM: Integration Connection Error', retries: 2 },
  { event: 'integration/connection.error' as const },
  async ({ event, step }) => {
    const { user_id, org_id, provider_id, reason } = event.data

    const pmEmail = await step.run('get-pm-email', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase.auth.admin.getUserById(user_id)
      return data?.user?.email ?? null
    })

    if (!pmEmail) return { sent: false, reason: 'no_pm_email' }

    await step.run('send-notification', async () => {
      const resend      = new Resend(process.env.RESEND_API_KEY)
      const appUrl      = process.env.NEXT_PUBLIC_APP_URL!
      const displayName = provider_id === 'ownerrez' ? 'OwnerRez' : provider_id

      await resend.emails.send({
        from:    process.env.RESEND_FROM_EMAIL!,
        to:      pmEmail,
        subject: `Action required — Your ${displayName} connection needs attention`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px;">
            <h2>&#9888;&#65039; Your ${displayName} connection has been interrupted</h2>
            <p>${reason}</p>
            <p>Your booking data and owner P&amp;L reports may be out of date until you reconnect.</p>
            <p>
              <a href="${appUrl}/dashboard/settings/integrations"
                 style="background:#FCD116;color:#0a1628;padding:12px 24px;
                        text-decoration:none;border-radius:6px;font-weight:bold;">
                Reconnect ${displayName} &rarr;
              </a>
            </p>
            <p style="color:#888;font-size:12px;">
              You're receiving this because you have an active FieldStay account.
            </p>
          </div>
        `,
      })
    })

    return { sent: true, to: pmEmail }
  }
)
