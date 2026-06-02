import { NextResponse }        from 'next/server'
import type { NextRequest }    from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code        = searchParams.get('code')
  const next        = searchParams.get('next') ?? '/onboarding'
  const inviteToken = searchParams.get('invite_token')

  if (code) {
    const supabase = await createClient()
    const { error, data } = await supabase.auth.exchangeCodeForSession(code)

    if (!error && data.session) {
      // Handle team invite token if present
      if (inviteToken) {
        await handleInviteAccept(data.session.user.id, data.session.user.email ?? '', inviteToken)
        return NextResponse.redirect(`${origin}/ops`)
      }
      return NextResponse.redirect(`${origin}${next}`)
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
    await admin
      .from('organization_members')
      .insert({
        org_id:  invite.org_id,
        user_id: userId,
        role:    invite.role,
      })
  }

  // Mark accepted
  await admin
    .from('org_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id)
}
