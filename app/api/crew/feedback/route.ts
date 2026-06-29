import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null)

  const feedbackText = typeof body?.feedbackText === 'string' ? body.feedbackText.trim() : ''
  const propertyId   = typeof body?.propertyId === 'string' ? body.propertyId : null

  if (!feedbackText) {
    return NextResponse.json({ error: 'Feedback text is required' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .not('invite_accepted_at', 'is', null)
    .single()

  if (!crew) return NextResponse.json({ error: 'Crew member not found' }, { status: 403 })

  // org_id + crew_member_id are derived server-side from the authenticated
  // session above; the insert goes through the service client so it isn't
  // blocked by the admin/manager-only manage policy on crew_feedback.
  const service = createServiceClient()
  const { error } = await service.from('crew_feedback').insert({
    org_id:         crew.org_id,
    crew_member_id: crew.id,
    property_id:    propertyId,
    feedback_text:  feedbackText,
  })

  if (error) {
    console.error('[CrewFeedback]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  return NextResponse.json({ submitted: true })
}
