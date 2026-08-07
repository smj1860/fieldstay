import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformStaff }      from '@/lib/auth'
import { reportError }               from '@/lib/observability/report-error'

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

  const { error: insertErr } = await supabase
    .from('support_messages')
    .insert({
      conversation_id: conversationId,
      role:            'human',
      content:         content.trim(),
      sent_by_user_id: user.id,
    })

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

  return NextResponse.json({ sent: true })
}
