'use server'

import { createClient }    from '@/lib/supabase/server'
import { acceptOrgInvite } from '@/lib/auth/invites'

import { reportError } from '@/lib/observability/report-error'
export async function acceptInviteForCurrentUser(
  inviteToken: string
): Promise<{ accepted: boolean }> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.email) return { accepted: false }

    const { accepted } = await acceptOrgInvite(user.id, user.email, inviteToken)
    return { accepted }
  } catch (err) {
    console.error('[acceptInviteForCurrentUser]', err)
    reportError(err, { site: 'serverAction.login.acceptInviteForCurrentUser' })
    return { accepted: false }
  }
}
