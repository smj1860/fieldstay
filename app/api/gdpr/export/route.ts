import { NextResponse }        from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'

/**
 * GET /api/gdpr/export
 *
 * GDPR Article 15 / CCPA — right of access / data portability.
 * Returns all personal data held for the authenticated user as a
 * structured JSON download. Requires a valid auth session.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Service client — fetches across org boundaries for a complete personal data picture
  const admin = createServiceClient()

  const [
    { data: profile },
    { data: memberships },
    { data: crewMember },
    { data: pushSubs },
    { data: auditEvents },
  ] = await Promise.all([
    admin.from('profiles').select('id, full_name, avatar_url, created_at').eq('id', user.id).single(),
    admin.from('organization_members').select('org_id, role, invite_accepted_at').eq('user_id', user.id),
    admin.from('crew_members').select('id, name, role, reliability_score, capacity_score, created_at').eq('user_id', user.id).maybeSingle(),
    admin.from('push_subscriptions').select('endpoint, created_at').eq('user_id', user.id),
    admin.from('audit_events').select('action, target_type, target_id, created_at').eq('actor_id', user.id).order('created_at', { ascending: false }).limit(500),
  ])

  const crewAssignments = crewMember
    ? (await admin
        .from('turnover_assignments')
        .select('turnover_id, assigned_at')
        .eq('crew_member_id', crewMember.id)
        .order('assigned_at', { ascending: false })
        .limit(200)).data
    : []

  const orgIds = (memberships ?? []).map((m) => m.org_id)

  await logAuditEvent({
    orgId:      orgIds[0] ?? undefined,
    actorId:    user.id,
    action:     'gdpr.data_export.requested',
    targetType: 'user',
    targetId:   user.id,
  })

  const payload = {
    exported_at:              new Date().toISOString(),
    account: {
      id:         user.id,
      email:      user.email,
      created_at: user.created_at,
      profile,
    },
    organization_memberships: memberships ?? [],
    crew_profile:             crewMember ?? null,
    crew_assignments:         crewAssignments ?? [],
    push_subscriptions:       (pushSubs ?? []).map(s => ({ endpoint: s.endpoint, created_at: s.created_at })),
    audit_trail:              auditEvents ?? [],
  }

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status:  200,
    headers: {
      'Content-Type':        'application/json',
      'Content-Disposition': `attachment; filename="fieldstay-data-export-${new Date().toISOString().split('T')[0]}.json"`,
    },
  })
}
