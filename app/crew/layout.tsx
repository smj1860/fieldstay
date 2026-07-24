import type { Metadata } from 'next'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { redirect } from 'next/navigation'
import { CrewShell } from './crew-shell'

export const metadata: Metadata = {
  manifest: '/manifest.json',
  themeColor: '#0D0E14',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
}

export default async function CrewLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Step 1: Read session via cookie-aware client
  const supabaseAuth = await createClient()
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

  if (authError || !user) {
    redirect('/login')
  }

  // ── PM / non-crew guard ────────────────────────────────────────────────────
  // Verify the authenticated user has an active crew_members record.
  // Uses service client to bypass RLS — lookup is scoped to user.id only.
  // Filters on is_active ONLY — NOT invite_accepted_at, matching the
  // canonical requireCrewMember() in lib/crew-auth.ts: ~a third of live crew
  // rows have invite_accepted_at IS NULL (onboarded outside the invite-link
  // flow), and gating on it here locked those real crew out of the entire
  // crew PWA (bounced to /ops with a spurious security.route.mismatch audit
  // entry).
  const admin = createServiceClient({ authenticatedUser: user })
  const { data: crewRecord } = await admin
    .from('crew_members')
    .select('id, name, org_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
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
    redirect('/ops')
  }
  // ── End PM guard ───────────────────────────────────────────────────────────

  return (
    <div className="theme-locked-light">
      <CrewShell crewName={crewRecord.name} userId={user.id}>{children}</CrewShell>
    </div>
  )
}
