import { NextResponse }        from 'next/server'
import type { NextRequest }    from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { inngest }             from '@/lib/inngest/client'
import { acceptOrgInvite }     from '@/lib/auth/invites'

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

    if (error) {
      // Specific error codes for triage
      const reason = error.message?.toLowerCase().includes('expired')
        ? 'link_expired'
        : error.message?.toLowerCase().includes('already')
          ? 'already_used'
          : 'auth_callback'
      return NextResponse.redirect(`${origin}/login?error=${reason}`)
    }

    if (data.session) {
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
        logAuditEvent({
          actorId:    data.session.user.id,
          action:     'auth.account.created',
          targetType: 'user',
          targetId:   data.session.user.id,
          metadata:   { email: data.session.user.email },
        }).catch(() => {})
      }

      // Handle team invite token if present
      if (inviteToken) {
        await acceptOrgInvite(data.session.user.id, data.session.user.email ?? '', inviteToken)
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

  return NextResponse.redirect(`${origin}/login?error=auth_callback_missing_code`)
}

