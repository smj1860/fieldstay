import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: staff } = await supabase
    .from('platform_staff')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!staff) return NextResponse.json({ error: 'Not staff' }, { status: 403 })

  const body = await req.json() as { conversationId?: string; content?: string }
  const { conversationId, content } = body

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

  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 })

  await supabase
    .from('support_conversations')
    .update({
      last_message_at:   new Date().toISOString(),
      assigned_staff_id: user.id,
    })
    .eq('id', conversationId)

  return NextResponse.json({ sent: true })
}
