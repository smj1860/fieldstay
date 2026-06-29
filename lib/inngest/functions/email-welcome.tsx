import { inngest }          from '@/lib/inngest/client'
import { resend, FROM }     from '@/lib/resend/client'
import { renderWelcomeEmail } from '@/emails/welcome'

export const sendWelcomeEmail = inngest.createFunction(
  { id: 'email-welcome', name: 'Send Welcome Email', retries: 3 },
  { event: 'org/created' },
  async ({ event, step }) => {
    const { org_id, user_email, first_name, org_name } = event.data
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!

    // 5-minute delay — let the setup wizard load first
    await step.sleep('delay-before-welcome', '5 minutes')

    await step.run('send-welcome-email', async () => {
      const html = await renderWelcomeEmail({
        firstName:       first_name,
        orgName:         org_name,
        dashboardUrl:    `${appUrl}/ops`,
        propertiesUrl:   `${appUrl}/properties`,
        crewUrl:         `${appUrl}/crew-manage`,
        integrationsUrl: `${appUrl}/settings?tab=integrations`,
      })

      await resend.emails.send(
        {
          from:     FROM,
          to:       user_email,
          replyTo:  'stephen@fieldstay.app',
          subject:  `Welcome to FieldStay, ${first_name}`,
          html,
        },
        { idempotencyKey: `welcome-email-${org_id}` }
      )
    })
  }
)
