import { NextRequest, NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { reportQueryError } from '@/lib/supabase/unwrap'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body?.milestone) {
    return NextResponse.json({ error: 'Missing milestone' }, { status: 400 })
  }

  // Derive org_id from the session — never from the client body
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('org_milestones')
    .update({ review_clicked: true, dismissed: true })
    .eq('org_id', membership.org_id)
    .eq('milestone', body.milestone)

  if (reportQueryError(error, { site: 'route.milestones.reviewClicked', orgId: membership.org_id })) {
    return NextResponse.json({ error: 'Failed to update milestone' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
