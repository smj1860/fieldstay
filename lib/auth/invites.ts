import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'

export async function acceptOrgInvite(
  userId: string,
  userEmail: string,
  inviteToken: string
): Promise<{ accepted: boolean; orgId?: string }> {
  const admin = createServiceClient()

  const { data: invite } = await admin
    .from('org_invites')
    .select('id, org_id, email, role, expires_at')
    .eq('token', inviteToken)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (!invite) return { accepted: false }
  if (invite.email.toLowerCase() !== userEmail.toLowerCase()) return { accepted: false }

  const { data: existing } = await admin
    .from('organization_members')
    .select('id')
    .eq('org_id', invite.org_id)
    .eq('user_id', userId)
    .single()

  if (!existing) {
    await admin.from('organization_members').insert({
      org_id:             invite.org_id,
      user_id:            userId,
      role:               invite.role,
      invite_accepted_at: new Date().toISOString(),
    })
  }

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

  return { accepted: true, orgId: invite.org_id }
}
