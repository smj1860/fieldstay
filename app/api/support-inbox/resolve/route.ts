import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformStaff }      from '@/lib/auth'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requirePlatformStaff()
  if (!auth.ok) return auth.response
  const { supabase } = auth

  const body = await req.json() as { conversationId?: string }
  const { conversationId } = body

  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })
  }

  const { error } = await supabase
    .from('support_conversations')
    .update({
      needs_human: false,
      resolved_at: new Date().toISOString(),
      status:      'closed',
    })
    .eq('id', conversationId)

  if (error) {
    console.error('[support-inbox/resolve]', error.message)
    return NextResponse.json({ error: 'Failed to resolve conversation. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ resolved: true })
}
