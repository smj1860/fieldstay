import { inngest }                      from '@/lib/inngest/client'
import { createServiceClient }           from '@/lib/supabase/server'
import { resend, FROM }                  from '@/lib/resend/client'
import { renderIntegrationErrorEmail }   from '@/lib/resend/emails/integration-error'

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  ownerrez:   'OwnerRez',
  kroger:     'Kroger',
  hostaway:   'Hostaway',
  hospitable: 'Hospitable',
}

export const notifyIntegrationError = inngest.createFunction(
  { id: 'notify-integration-error', name: 'Notify PM: Integration Connection Error', retries: 2 },
  { event: 'integration/connection.error' as const },
  async ({ event, step }) => {
    const { user_id, provider_id, reason } = event.data

    const pmEmail = await step.run('get-pm-email', async () => {
      const admin = createServiceClient()
      const { data } = await admin.auth.admin.getUserById(user_id)
      return data?.user?.email ?? null
    })

    if (!pmEmail) return { sent: false, reason: 'no_pm_email' }

    await step.run('send-notification', async () => {
      const appUrl      = process.env.NEXT_PUBLIC_APP_URL!
      const providerName = PROVIDER_DISPLAY_NAMES[provider_id] ?? provider_id
      const reconnectUrl = `${appUrl}/settings/integrations`

      const html = await renderIntegrationErrorEmail({ providerName, reason, reconnectUrl })
      const today = new Date().toISOString().split('T')[0]

      await resend.emails.send(
        {
          from:    FROM,
          to:      pmEmail,
          subject: `Action required — Your ${providerName} connection needs attention`,
          html,
        },
        { idempotencyKey: `integration-error-${user_id}-${provider_id}-${today}` }
      )
    })

    return { sent: true, to: pmEmail }
  }
)
