import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireCrewMember }   from '@/lib/crew-auth'
import { resend, FROM }              from '@/lib/resend/client'
import { renderPmAlert }             from '@/lib/resend/emails/pm-alert'

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

  // Notify platform staff — fire-and-forget, never blocks the crew's success state.
  void notifyPlatformStaff(crew.id, crew.org_id, feedbackText)
    .catch((err) => console.error('[CrewFeedback] staff notify failed:', err))

  return NextResponse.json({ submitted: true })
}

async function notifyPlatformStaff(
  crewMemberId: string,
  orgId:        string,
  feedbackText: string,
): Promise<void> {
  const service = createServiceClient()

  const [{ data: cm }, { data: org }] = await Promise.all([
    service.from('crew_members').select('name').eq('id', crewMemberId).single(),
    service.from('organizations').select('name').eq('id', orgId).single(),
  ])

  await resend.emails.send({
    from:    FROM,
    to:      'stephen@fieldstay.app',
    subject: `New crew feedback from ${cm?.name ?? 'a crew member'}`,
    html: await renderPmAlert({
      heading: 'New crew feedback submitted',
      body:    feedbackText,
      details: [
        { label: 'Crew member',  value: cm?.name ?? null },
        { label: 'Organization', value: org?.name ?? null },
      ],
      ctaLabel: 'View in Support Inbox →',
      ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/support-inbox`,
    }),
  })
}
