import { inngest } from '@/lib/inngest/client'

export const handleSupportEscalation = inngest.createFunction(
  { id: 'support-conversation-escalated', name: 'Support: Conversation Escalated', retries: 2 },
  { event: 'support/conversation.escalated' },
  async ({ event, step }) => {
    const { conversationId, orgId, reason } = event.data

    const context = await step.run('fetch-context', async () => {
      const { createServiceClient } = await import('@/lib/supabase/server')
      const supabase = createServiceClient()

      const [{ data: org }, { data: conversation }] = await Promise.all([
        supabase.from('organizations').select('name').eq('id', orgId).single(),
        supabase
          .from('support_conversations')
          .select('id, staff_notified_at')
          .eq('id', conversationId)
          .eq('org_id', orgId)
          .single(),
      ])

      return {
        orgName:         org?.name ?? 'Unknown Org',
        alreadyNotified: !!conversation?.staff_notified_at,
      }
    })

    if (context.alreadyNotified) {
      return { skipped: 'already_notified' }
    }

    await step.run('notify-stephen', async () => {
      const { createServiceClient } = await import('@/lib/supabase/server')
      const { resend, FROM }        = await import('@/lib/resend/client')
      const supabase = createServiceClient()

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

      await resend.emails.send(
        {
          from:    FROM,
          to:      ['stephen@fieldstay.app'],
          subject: `Support escalation — ${context.orgName}`,
          html: `
            <p><strong>${context.orgName}</strong> needs human follow-up in the support chat.</p>
            <p><em>${reason}</em></p>
            <p><a href="${appUrl}/support-inbox?conversation=${conversationId}">Open conversation →</a></p>
          `,
        },
        { idempotencyKey: `support-escalation-${conversationId}` }
      )

      await supabase
        .from('support_conversations')
        .update({ staff_notified_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('org_id', orgId)
    })

    return { notified: true, org: context.orgName }
  }
)
