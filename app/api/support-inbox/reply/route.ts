import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformStaff }      from '@/lib/auth'
import { reportError }               from '@/lib/observability/report-error'
import { inngest }                   from '@/lib/inngest/client'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requirePlatformStaff()
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  const body = await req.json() as { conversationId?: string; content?: string }
  const { conversationId, content } = body

  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
  }

  if (!content?.trim()) {
    return NextResponse.json({ error: 'Message content is required' }, { status: 400 })
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('support_messages')
    .insert({
      conversation_id: conversationId,
      role:            'human',
      content:         content.trim(),
      sent_by_user_id: user.id,
    })
    .select('id')
    .single()

  if (insertErr) {
    console.error('[support-inbox/reply]', insertErr.message)
    return NextResponse.json({ error: 'Failed to send reply. Please try again.' }, { status: 500 })
  }

  const { error: updateErr } = await supabase
    .from('support_conversations')
    .update({
      last_message_at:   new Date().toISOString(),
      assigned_staff_id: user.id,
    })
    .eq('id', conversationId)

  if (updateErr) {
    console.error('[support-inbox/reply] conversation update', updateErr.message)
    reportError(updateErr, { site: 'route.support-inbox.reply.updateConversation' })
  }

  // The reply is saved and shows live if the customer's chat is open. This
  // reaches them when it is not. Best effort: the reply is already stored, so
  // a failure to queue the email must not turn a successful reply into an error.
  if (inserted?.id) {
    try {
      await inngest.send({
        name: 'support/staff-reply.sent',
        id:   `support-staff-reply-${inserted.id}`,
        data: { conversationId, messageId: inserted.id as string },
      })
    } catch (err) {
      reportError(err, { site: 'route.support-inbox.reply.notifyCustomer', level: 'warning' })
    }
  }

  return NextResponse.json({ sent: true })
}
