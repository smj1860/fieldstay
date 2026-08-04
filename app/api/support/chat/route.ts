import { tryUnwrapList } from '@/lib/supabase/unwrap'
import { NextRequest, NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { classifyIntent } from '@/lib/support/classify'
import { generateResponse } from '@/lib/support/respond'
import { inngest } from '@/lib/inngest/client'
import { supportChatLimiter, supportChatDailyLimiter, checkLimit } from '@/lib/rate-limit'

export async function POST(req: NextRequest) {
  const { supabase, user, membership } = await requireOrgMember()

  // Burst limiter (20/min) → fails OPEN: this is anti-spam, not a spend
  // ceiling, and a Redis outage must not take down support entirely.
  const minute = await checkLimit(supportChatLimiter, user.id, {
    onError: 'allow',
    site:    'route.support.chat.minute',
  })
  if (!minute.allowed) {
    return NextResponse.json(
      { error: 'Too many messages. Please wait a moment before sending another.' },
      { status: 429 }
    )
  }

  // Daily cap (100/day) → fails CLOSED: this one IS a spend ceiling — every
  // message downstream is a billed LLM call — and a ceiling that disappears
  // during an outage is not a ceiling. Same convention as
  // claimNudgeBudgetSlot (CLAUDE.md, SMS section).
  const daily = await checkLimit(supportChatDailyLimiter, user.id, {
    onError: 'deny',
    site:    'route.support.chat.daily',
  })
  if (!daily.allowed) {
    return NextResponse.json(
      { error: 'Daily message limit reached. Please try again tomorrow or email support@fieldstay.app.' },
      { status: 429 }
    )
  }

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

  // Degrade, don't throw: losing prior turns makes the reply worse, not
  // wrong, and the user should still get an answer.
  const recentRes = await supabase
    .from('support_messages')
    .select('role, content')
    .eq('conversation_id', convoId)
    .order('created_at', { ascending: false })
    .limit(10)

  const recentOut = tryUnwrapList(recentRes, { site: 'api.support.chat.history' })
  const recentRows = recentOut.ok ? recentOut.data : []

  const historyRows = (recentRows ?? []).reverse()

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

  const { content, modelUsed, needsEscalation, escalationReason } = await generateResponse({ category, message, history, orgId: membership.org_id })

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
    const reason = escalationReason || content.slice(0, 280)

    await supabase
      .from('support_conversations')
      .update({
        needs_human:       true,
        escalation_reason: reason,
        escalated_at:      now,
      })
      .eq('id', convoId)
      .eq('org_id', membership.org_id)

    await inngest.send({
      name: 'support/conversation.escalated',
      data: {
        conversationId: convoId,
        orgId:          membership.org_id,
        reason:         reason,
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
