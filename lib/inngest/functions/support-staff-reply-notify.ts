import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { isRealQueryError, throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import { resend, FROM, sendWithTimeout } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'

// A reply is a few sentences. The cap only stops one very long message from
// turning a notification into a wall of text; the full text is in the chat.
const MAX_EMAIL_BODY_CHARS = 1500

interface ReplyTarget {
  userId:  string
  content: string
}

/**
 * Tells a customer that FieldStay staff replied to them in the support chat.
 *
 * The reply itself is saved before this runs and appears live in the widget if
 * the customer has it open. This covers the case it cannot: a customer who is
 * logged out or has closed the tab would otherwise never learn a reply exists.
 *
 * Debounced per conversation, so a staff member sending several short messages
 * in a row produces one email about the last of them rather than one each.
 */
export const notifySupportStaffReply = inngest.createFunction(
  {
    id:       'support-staff-reply-notify',
    name:     'Support: Notify Customer of Staff Reply',
    retries:  2,
    debounce: { key: 'event.data.conversationId', period: '90s', timeout: '10m' },
  },
  { event: 'support/staff-reply.sent' },
  async ({ event, step }) => {
    const { conversationId, messageId } = event.data

    const target = await step.run('load-reply', async (): Promise<ReplyTarget | null> => {
      const supabase = createServiceClient({ system: 'inngest:support-staff-reply-notify' })

      const { data: message, error: messageError } = await supabase
        .from('support_messages')
        .select('role, content')
        .eq('id', messageId)
        .eq('conversation_id', conversationId)
        .maybeSingle()
      const { data: conversation, error: conversationError } = await supabase
        .from('support_conversations')
        .select('user_id')
        .eq('id', conversationId)
        .maybeSingle()
      throwIfAnyQueryFailed(
        { site: 'inngest.support-staff-reply-notify.load-reply' },
        isRealQueryError(messageError) ? messageError : null,
        isRealQueryError(conversationError) ? conversationError : null,
      )

      // Only a staff message is worth an email. A missing row means the
      // message or conversation was deleted since the event was sent.
      if (message?.role !== 'human' || !conversation?.user_id) return null
      return { userId: conversation.user_id as string, content: message.content as string }
    })

    if (!target) return { skipped: 'nothing_to_send' }

    return step.run('email-customer', async () => {
      const admin = createServiceClient({ system: 'inngest:support-staff-reply-notify' })
      const { data: userRecord, error: userError } = await admin.auth.admin.getUserById(target.userId)

      // Thrown, not swallowed: a transient auth lookup failure should retry,
      // and one that keeps failing should surface instead of looking sent.
      if (userError) {
        reportError(userError, { site: 'inngest.support-staff-reply-notify.recipient' })
        throw new Error('Could not look up the customer to notify of a support reply')
      }

      const to = userRecord?.user?.email
      if (!to) return { sent: false, reason: 'no_email' }

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
      const body = target.content.length > MAX_EMAIL_BODY_CHARS
        ? `${target.content.slice(0, MAX_EMAIL_BODY_CHARS)}...`
        : target.content

      const html = await renderPmAlert({
        heading:  'You have a reply from FieldStay Support',
        body,
        ctaLabel: 'Open FieldStay',
        ctaUrl:   appUrl,
        note:     'To answer, sign in and use the chat bubble in the corner of any page.',
      })

      await sendWithTimeout(() => resend.emails.send(
        { from: FROM, to, subject: 'FieldStay Support replied to your message', html },
        { idempotencyKey: `support-staff-reply-${messageId}` },
      ))
      return { sent: true }
    })
  },
)
