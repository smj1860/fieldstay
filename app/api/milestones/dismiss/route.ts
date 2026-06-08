import { NextRequest, NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.milestone) {
    return NextResponse.json({ error: 'Missing milestone' }, { status: 400 })
  }

  // Derive org_id from the session — never from the client body
  const { supabase, membership } = await requireOrgMember()

  await supabase
    .from('org_milestones')
    .update({ dismissed: true })
    .eq('org_id', membership.org_id)
    .eq('milestone', body.milestone)

  return NextResponse.json({ success: true })
}
