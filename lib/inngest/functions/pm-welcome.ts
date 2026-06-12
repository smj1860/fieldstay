import { inngest } from '@/lib/inngest/client'
import { sendPmWelcomeEmail } from '@/lib/resend/client'

export const pmWelcome = inngest.createFunction(
  { id: 'pm-welcome', name: 'PM Welcome Email', retries: 3 },
  { event: 'user/pm.signed_up' },
  async ({ event, step }) => {
    await step.run('send-welcome-email', async () => {
      await sendPmWelcomeEmail({
        toEmail: event.data.email,
        orgName: event.data.org_name,
      })
    })
  }
)
