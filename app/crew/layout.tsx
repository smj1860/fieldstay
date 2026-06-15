import type { Metadata } from 'next'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { redirect } from 'next/navigation'
import { CrewShell } from './crew-shell'

export const metadata: Metadata = {
  manifest: '/manifest.webmanifest',
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
}: {
  children: React.ReactNode
}) {
  // Step 1: Read session via cookie-aware client
  const supabaseAuth = await createClient()
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()

  if (authError || !user) {
    redirect('/login')
  }

  // ── PM / non-crew guard ────────────────────────────────────────────────────
  // Verify the authenticated user has an active, accepted crew_members record.
  // Uses service client to bypass RLS — lookup is scoped to user.id only.
  const admin = createServiceClient()
  const { data: crewRecord } = await admin
    .from('crew_members')
    .select('id, name, org_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .not('invite_accepted_at', 'is', null)
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
