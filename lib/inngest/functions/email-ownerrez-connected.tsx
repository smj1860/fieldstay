import { inngest }                   from '@/lib/inngest/client'
import { createServiceClient }       from '@/lib/supabase/server'
import { resend, FROM }              from '@/lib/resend/client'
import { renderOwnerRezConnectedEmail } from '@/emails/ownerrez-connected'

export const sendOwnerRezConnectedEmail = inngest.createFunction(
  { id: 'email-ownerrez-connected', name: 'Send OwnerRez Connected Email', retries: 3 },
  { event: 'integration/ownerrez.connected' },
  async ({ event, step }) => {
    const { user_id, org_id } = event.data
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!

    const { userEmail, firstName, orgName } = await step.run('fetch-user', async () => {
      const supabase = createServiceClient()

      const [{ data: { user } }, { data: org }] = await Promise.all([
        supabase.auth.admin.getUserById(user_id),
        supabase.from('organizations').select('name').eq('id', org_id).single(),
      ])

      const fullName = user?.user_metadata?.full_name as string | undefined
      return {
        userEmail: user?.email ?? '',
        firstName: fullName?.split(' ')[0] ?? 'there',
        orgName:   org?.name ?? 'your organization',
      }
    })

    if (!userEmail) return

    await step.run('send-email', async () => {
      const html = await renderOwnerRezConnectedEmail({
        firstName,
        orgName,
        dashboardUrl: `${appUrl}/properties`,
      })

      await resend.emails.send(
        {
          from:     FROM,
          to:       userEmail,
          replyTo:  'stephen@fieldstay.app',
          subject:  'OwnerRez connected — your properties are syncing',
          html,
        },
        { idempotencyKey: `ownerrez-connected-${org_id}-${user_id}` }
      )
    })
  }
)
