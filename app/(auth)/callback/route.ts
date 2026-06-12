import { NextResponse }        from 'next/server'
import type { NextRequest }    from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { inngest }             from '@/lib/inngest/client'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code        = searchParams.get('code')
  const rawNext     = searchParams.get('next') ?? '/onboarding'
  // C-1: only allow same-origin relative paths — reject protocol-relative and absolute URLs
  const next        = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/onboarding'
  const inviteToken = searchParams.get('invite_token')

  if (code) {
    const supabase = await createClient()
    const { error, data } = await supabase.auth.exchangeCodeForSession(code)

    if (!error && data.session) {
      // Audit every successful OAuth callback for SOC2 compliance
      // Fire-and-forget: audit failure must never block authentication
      logAuditEvent({
        actorId:    data.session.user.id,
        action:     'auth.oauth.callback',
        targetType: 'user',
        targetId:   data.session.user.id,
        metadata:   { provider: data.session.user.app_metadata?.provider ?? 'unknown' },
      }).catch(() => {})

      // Fire welcome email for brand-new accounts (created within the last 60 seconds)
      const createdAt = data.session.user.created_at
      const isNew     = createdAt && (Date.now() - new Date(createdAt).getTime()) < 60_000
      if (isNew && data.session.user.email && !inviteToken) {
        const admin = createServiceClient()
        const { data: membership } = await admin
          .from('organization_members')
          .select('org_id, organizations(name)')
          .eq('user_id', data.session.user.id)
          .limit(1)
          .maybeSingle()

        if (membership?.org_id) {
          const orgName = (membership as unknown as { organizations?: { name: string } | null })
            .organizations?.name ?? 'your organization'
          inngest.send({
            name: 'user/pm.signed_up',
            data: {
              user_id:  data.session.user.id,
              email:    data.session.user.email,
              org_id:   membership.org_id,
              org_name: orgName,
            },
          }).catch(() => {})
        }
      }

      // Handle team invite token if present
      if (inviteToken) {
        await handleInviteAccept(data.session.user.id, data.session.user.email ?? '', inviteToken)
        return NextResponse.redirect(`${origin}/ops`)
      }

      // If next is still the default, check the OAuth cookie set by GoogleSignInButton
      let finalNext = next
      if (next === '/onboarding' && request.cookies.has('fs-oauth-next')) {
        const cookieVal = decodeURIComponent(request.cookies.get('fs-oauth-next')!.value)
        if (cookieVal.startsWith('/') && !cookieVal.startsWith('//')) {
          finalNext = cookieVal
        }
      }

      const response = NextResponse.redirect(`${origin}${finalNext}`)
      // Always clear the OAuth next cookie on a successful callback
      response.cookies.set('fs-oauth-next', '', { maxAge: 0, path: '/' })
      return response
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback`)
}

async function handleInviteAccept(userId: string, userEmail: string, inviteToken: string) {
  const admin = createServiceClient()

  const { data: invite } = await admin
    .from('org_invites')
    .select('id, org_id, email, role, expires_at')
    .eq('token', inviteToken)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (!invite) return

  // Verify email matches
  if (invite.email.toLowerCase() !== userEmail.toLowerCase()) return

  // Add to org (ignore if already a member)
  const { data: existing } = await admin
    .from('organization_members')
    .select('id')
    .eq('org_id', invite.org_id)
    .eq('user_id', userId)
    .single()

  if (!existing) {
    // C-2: record invite_accepted_at on the membership row
    await admin
      .from('organization_members')
      .insert({
        org_id:             invite.org_id,
        user_id:            userId,
        role:               invite.role,
        invite_accepted_at: new Date().toISOString(),
      })
  }

  // Mark accepted
  await admin
    .from('org_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id)

  await logAuditEvent({
    orgId:      invite.org_id,
    actorId:    userId,
    action:     'auth.invite.accepted',
    targetType: 'org_invite',
    targetId:   invite.id,
    metadata:   { email: userEmail, role: invite.role },
  })
}
