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

  const body = await req.json() as { conversationId?: string }
  const { conversationId } = body

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
