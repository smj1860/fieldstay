// lib/inngest/functions/email-hospitable-connected.tsx

import { inngest }                        from '@/lib/inngest/client'
import { createServiceClient }            from '@/lib/supabase/server'
import { resend, FROM }                   from '@/lib/resend/client'
import { renderHospitableConnectedEmail } from '@/emails/hospitable-connected'

export const sendHospitableConnectedEmail = inngest.createFunction(
  { id: 'email-hospitable-connected', name: 'Send Hospitable Connected Email', retries: 3 },
  { event: 'integration/hospitable.connected' as const },
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
      const html = await renderHospitableConnectedEmail({
        firstName,
        orgName,
        dashboardUrl: `${appUrl}/properties`,
      })

      await resend.emails.send(
        {
          from:    FROM,
          to:      userEmail,
          replyTo: 'stephen@fieldstay.app',
          subject: 'Hospitable connected — your properties are syncing',
          html,
        },
        { idempotencyKey: `hospitable-connected-${org_id}-${user_id}` }
      )
    })
  }
)
