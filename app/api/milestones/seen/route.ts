import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.milestone || !body?.orgId) {
    return NextResponse.json({ error: 'Missing milestone or orgId' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await supabase
    .from('org_milestones')
    .update({ prompted_at: new Date().toISOString() })
    .eq('org_id', body.orgId)
    .eq('milestone', body.milestone)

  return NextResponse.json({ success: true })
}
