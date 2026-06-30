import { NextRequest, NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { classifyIntent } from '@/lib/support/classify'
import { generateResponse } from '@/lib/support/respond'
import { inngest } from '@/lib/inngest/client'

export async function POST(req: NextRequest) {
  const { supabase, user, membership } = await requireOrgMember()

  const body = await req.json().catch(() => null)
  const message        = body?.message        as string | undefined
  const conversationId = body?.conversationId as string | undefined

  if (!message || message.trim().length === 0) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 })
  }

  let convoId = conversationId

  if (!convoId) {
    const { data: convo, error: convoErr } = await supabase
      .from('support_conversations')
      .insert({ org_id: membership.org_id, user_id: user.id })
      .select('id')
      .single()

    if (convoErr || !convo) {
      console.error('[support/chat] failed to create conversation', convoErr)
      return NextResponse.json({ error: 'Could not start conversation' }, { status: 500 })
    }
    convoId = convo.id as string
  } else {
    const { data: existing, error: existingErr } = await supabase
      .from('support_conversations')
      .select('id')
      .eq('id', convoId)
      .eq('user_id', user.id)
      .eq('org_id', membership.org_id)
      .single()

    if (existingErr || !existing) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
  }

  const { data: historyRows } = await supabase
    .from('support_messages')
    .select('role, content')
    .eq('conversation_id', convoId)
    .order('created_at', { ascending: true })
    .limit(10)

  const history = (historyRows ?? []).map((r) => ({
    role:    r.role    as 'user' | 'assistant',
    content: r.content as string,
  }))

  const category = await classifyIntent(message)

  const { error: userInsertErr } = await supabase.from('support_messages').insert({
    conversation_id: convoId,
    role:            'user',
    content:         message,
    category,
  })
  if (userInsertErr) {
    console.error('[support/chat] failed to persist user message', userInsertErr)
  }

  const { content, modelUsed, needsEscalation } = await generateResponse({ category, message, history, orgId: membership.org_id })

  const { error: assistantInsertErr } = await supabase.from('support_messages').insert({
    conversation_id: convoId,
    role:            'assistant',
    content,
    model_used:      modelUsed,
  })
  if (assistantInsertErr) {
    console.error('[support/chat] failed to persist assistant message', assistantInsertErr)
  }

  const now = new Date().toISOString()

  await supabase
    .from('support_conversations')
    .update({ last_message_at: now })
    .eq('id', convoId)

  if (needsEscalation) {
    await supabase
      .from('support_conversations')
      .update({
        needs_human:       true,
        escalation_reason: content.slice(0, 280),
        escalated_at:      now,
      })
      .eq('id', convoId)
      .eq('org_id', membership.org_id)

    await inngest.send({
      name: 'support/conversation.escalated',
      data: {
        conversationId: convoId,
        orgId:          membership.org_id,
        reason:         content.slice(0, 280),
      },
    })
  }

  return NextResponse.json({
    conversationId:  convoId,
    category,
    reply:           content,
    modelUsed,
    needsEscalation,
  })
}
