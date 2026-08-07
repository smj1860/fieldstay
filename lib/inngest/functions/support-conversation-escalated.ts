import { inngest }    from '@/lib/inngest/client'
import { escapeHtml } from '@/lib/utils/html'
import { throwIfAnyQueryFailed, isRealQueryError } from '@/lib/supabase/unwrap'

export const handleSupportEscalation = inngest.createFunction(
  { id: 'support-conversation-escalated', name: 'Support: Conversation Escalated', retries: 2 },
  { event: 'support/conversation.escalated' },
  async ({ event, step }) => {
    const { conversationId, orgId, reason } = event.data

    const context = await step.run('fetch-context', async () => {
      const { createServiceClient } = await import('@/lib/supabase/server')
      const supabase = createServiceClient({ system: 'inngest:support-conversation-escalated' })

      const [
        { data: org, error: orgError },
        { data: conversation, error: conversationError },
      ] = await Promise.all([
        supabase.from('organizations').select('name').eq('id', orgId).single(),
        supabase
          .from('support_conversations')
          .select('id, staff_notified_at')
          .eq('id', conversationId)
          .eq('org_id', orgId)
          .single(),
      ])
      throwIfAnyQueryFailed(
        { site: 'inngest.support-conversation-escalated.fetch-context', orgId },
        isRealQueryError(orgError) ? orgError : null,
        isRealQueryError(conversationError) ? conversationError : null,
      )

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
      const supabase = createServiceClient({ system: 'inngest:support-conversation-escalated' })

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

      await resend.emails.send(
        {
          from:    FROM,
          to:      ['stephen@fieldstay.app'],
          subject: `Support escalation — ${context.orgName}`,
          html: `
            <p><strong>${escapeHtml(context.orgName)}</strong> needs human follow-up in the support chat.</p>
            <p><em>${escapeHtml(reason)}</em></p>
            <p><a href="${appUrl}/support-inbox?conversation=${conversationId}">Open conversation →</a></p>
          `,
        },
        { idempotencyKey: `support-escalation-${conversationId}` }
      )

      const { error } = await supabase
        .from('support_conversations')
        .update({ staff_notified_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('org_id', orgId)

      throwIfAnyQueryFailed(
        { site: 'inngest.support-conversation-escalated.notify-stephen', orgId },
        error
      )
    })

    return { notified: true, org: context.orgName }
  }
)
