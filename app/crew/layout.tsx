import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { redirect } from 'next/navigation'
import { CrewShell } from './crew-shell'

export default async function CrewLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createServiceClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Unauthenticated users — middleware handles the /login redirect for
  // protected crew routes. The /crew/install and /crew/accept-invite paths
  // are in PUBLIC_ROUTES so they bypass this layout's auth requirement.
  if (!user) {
    // Only redirect if this is a protected sub-route (not install or accept-invite)
    // Middleware should have already handled this, but defend in depth.
    redirect('/login')
  }

  // ── PM / non-crew guard ────────────────────────────────────────────────────
  // Verify the authenticated user has a crew_members record before allowing
  // access to any /crew/** route. A PM who navigates here gets sent to /dashboard.
  const { data: crewRecord } = await supabase
    .from('crew_members')
    .select('id, name, org_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!crewRecord) {
    await logAuditEvent({
      actorId:    user.id,
      action:     'security.route.mismatch',
      targetType: 'route',
      targetId:   '/crew',
      metadata: {
        reason: 'non_crew_user_reached_crew_app',
      },
    })
    redirect('/dashboard')
  }
  // ── End PM guard ───────────────────────────────────────────────────────────

  return <CrewShell crewName={crewRecord.name} userId={user.id}>{children}</CrewShell>
}
