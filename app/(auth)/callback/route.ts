import { NextResponse }        from 'next/server'
import type { NextRequest }    from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { acceptOrgInvite }     from '@/lib/auth/invites'
import { safeNextPath }        from '@/lib/auth/safe-redirect'

function classifyAuthError(error: { message?: string }): string {
  const msg = error.message?.toLowerCase() ?? ''
  if (msg.includes('expired')) return 'link_expired'
  if (msg.includes('already'))  return 'already_used'
  return 'auth_callback'
}

// Both the ?next= param and the fs-oauth-next cookie go through the shared
// validator. The local copies this replaced used a startsWith check, which
// admits `/\evil.com` — a string every browser resolves to a DIFFERENT origin.
// It was harmless here only because this route concatenates `origin + path`
// rather than parsing; the two client forms had no check at all. See
// lib/auth/safe-redirect.ts.
function resolveOAuthNext(next: string, request: NextRequest): string {
  if (next !== '/onboarding' || !request.cookies.has('fs-oauth-next')) return next
  const cookieVal = decodeURIComponent(request.cookies.get('fs-oauth-next')!.value)
  return safeNextPath(cookieVal, next)
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code        = searchParams.get('code')
  const next        = safeNextPath(searchParams.get('next'), '/onboarding')
  const inviteToken = searchParams.get('invite_token')

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_missing_code`)
  }

  const supabase = await createClient()
  const { error, data } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${classifyAuthError(error)}`)
  }

  if (!data.session) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_missing_code`)
  }

  const { session } = data

  // Audit every successful OAuth callback for SOC2 compliance
  // Fire-and-forget: audit failure must never block authentication
  logAuditEvent({
    actorId:    session.user.id,
    action:     'auth.oauth.callback',
    targetType: 'user',
    targetId:   session.user.id,
    metadata:   { provider: session.user.app_metadata?.provider ?? 'unknown' },
  }).catch(() => {})

  // Fire welcome email for brand-new accounts (created within the last 60 seconds)
  const createdAt = session.user.created_at
  const isNew     = createdAt && (Date.now() - new Date(createdAt).getTime()) < 60_000
  if (isNew && session.user.email && !inviteToken) {
    logAuditEvent({
      actorId:    session.user.id,
      action:     'auth.account.created',
      targetType: 'user',
      targetId:   session.user.id,
      // Intentionally omit the address — no PII in audit metadata. targetId
      // is the auth user id, which resolves to the account either way.
      metadata:   { provider: session.user.app_metadata?.provider ?? 'unknown' },
    }).catch(() => {})
  }

  // Handle team invite token if present.
  //
  // The result is branched on, not discarded. acceptOrgInvite returns false for
  // an expired or already-claimed token, an email that does not match the
  // invite, a lost claim race, and — deliberately — a crew-role org invite,
  // which it refuses because an organization_members row would grant a cleaner
  // read access to the whole org's turnovers, bookings and guest PII.
  //
  // This used to redirect to /ops unconditionally. With no membership row,
  // requireOrgMember() then bounced the user to /onboarding, where they were
  // shown "Name your organization" with nothing explaining what happened — so
  // someone who clicked "join my teammate's account" silently created their own
  // separate org instead. The password-signup path (acceptTeamInvite) has
  // always checked this result; the two OAuth/login paths did not.
  if (inviteToken) {
    const { accepted } = await acceptOrgInvite(session.user.id, session.user.email ?? '', inviteToken)
    return NextResponse.redirect(`${origin}${accepted ? '/ops' : '/onboarding?invite=invalid'}`)
  }

  const finalNext  = resolveOAuthNext(next, request)
  const response   = NextResponse.redirect(`${origin}${finalNext}`)
  // Always clear the OAuth next cookie on a successful callback
  response.cookies.set('fs-oauth-next', '', { maxAge: 0, path: '/' })
  return response
}

