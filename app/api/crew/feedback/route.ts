import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCrewMember }   from '@/lib/crew-auth'
import { inngest }             from '@/lib/inngest/client'
import { reportError }         from '@/lib/observability/report-error'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null)

  const feedbackText = typeof body?.feedbackText === 'string' ? body.feedbackText.trim() : ''
  const propertyId   = typeof body?.propertyId === 'string' ? body.propertyId : null

  if (!feedbackText) {
    return NextResponse.json({ error: 'Feedback text is required' }, { status: 400 })
  }

  // Canonical crew gate (lib/crew-auth.ts) — a previous inline copy here
  // added an invite_accepted_at filter that locked out the ~third of live
  // crew rows onboarded outside the invite-link flow.
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { crew } = auth

  // org_id + crew_member_id are derived server-side from the authenticated
  // session above; the insert goes through the service client so it isn't
  // blocked by the admin/manager-only manage policy on crew_feedback.
  const service = createServiceClient({ system: 'route:crew-feedback-notify-staff' })
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

  // Staff notification goes through Inngest for retry/durability instead of
  // a fire-and-forget email send that a torn-down serverless instance could
  // silently drop. Awaiting the event send (not the email itself) confirms
  // Inngest accepted the job; a send failure here is logged but still
  // doesn't block the crew member's success response — the feedback row
  // above is already durably written.
  try {
    await inngest.send({
      name: 'crew/feedback.submitted',
      data: { org_id: crew.org_id, crew_member_id: crew.id, feedback_text: feedbackText },
    })
  } catch (err) {
    console.error('[CrewFeedback] failed to enqueue staff notification:', err)
    reportError(err, { site: 'route.crew.feedback.notify_enqueue', orgId: crew.org_id })
  }

  return NextResponse.json({ submitted: true })
}
