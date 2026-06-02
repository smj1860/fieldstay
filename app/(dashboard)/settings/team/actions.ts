'use server'

import { requireOrgMember }         from '@/lib/auth'
import { createServiceClient }      from '@/lib/supabase/server'
import { sendTeamInviteEmail }       from '@/lib/resend/client'
import { revalidatePath }            from 'next/cache'

export async function inviteTeamMember(
  email: string
): Promise<{ ok?: true; error?: string }> {
  const { user, membership } = await requireOrgMember()

  if (membership.role !== 'owner') {
    return { error: 'Only the account owner can invite team members.' }
  }

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return { error: 'Email is required.' }

  const admin = createServiceClient()

  // Check not already a member
  const { data: existing } = await admin
    .from('organization_members')
    .select('id')
    .eq('org_id', membership.org_id)
    .eq('user_id', (
      await admin
        .from('organization_members')
        .select('user_id')
        .eq('org_id', membership.org_id)
    ).data?.map(m => m.user_id).join(',') ?? '')
    .limit(1)

  // Simpler: check via auth.users email
  const { data: authUsers } = await admin.auth.admin.listUsers()
  const matchingUser = authUsers?.users.find(u => u.email === normalizedEmail)
  if (matchingUser) {
    const { data: memberRow } = await admin
      .from('organization_members')
      .select('id')
      .eq('org_id', membership.org_id)
      .eq('user_id', matchingUser.id)
      .single()
    if (memberRow) {
      return { error: 'This person is already a member of your organization.' }
    }
  }

  // Check no active pending invite
  const { data: existingInvite } = await admin
    .from('org_invites')
    .select('id')
    .eq('org_id', membership.org_id)
    .eq('email', normalizedEmail)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (existingInvite) {
    return { error: 'A pending invitation already exists for this email.' }
  }

  // Create invite record
  const { data: invite, error: insertError } = await admin
    .from('org_invites')
    .insert({
      org_id:     membership.org_id,
      invited_by: user.id,
      email:      normalizedEmail,
      role:       'admin',
    })
    .select('token')
    .single()

  if (insertError || !invite) {
    console.error(`[Team:${user.id}] invite insert failed:`, insertError?.message)
    return { error: 'Failed to create invitation. Please try again.' }
  }

  // Send invite email
  try {
    await sendTeamInviteEmail({
      toEmail:      normalizedEmail,
      inviterEmail: user.email ?? 'your team',
      orgName:      membership.org.name,
      inviteToken:  invite.token,
    })
  } catch (err) {
    console.error(`[Team:${user.id}] invite email failed:`, err instanceof Error ? err.message : err)
    // Non-fatal — invite record exists, user can resend
  }

  revalidatePath('/settings/team')
  return { ok: true }
}

export async function removeMember(
  targetUserId: string
): Promise<{ ok?: true; error?: string }> {
  const { user, membership } = await requireOrgMember()

  if (membership.role !== 'owner') {
    return { error: 'Only the account owner can remove team members.' }
  }

  if (targetUserId === user.id) {
    return { error: 'You cannot remove yourself from the organization.' }
  }

  const admin = createServiceClient()

  // Prevent removing another owner
  const { data: targetMember } = await admin
    .from('organization_members')
    .select('role')
    .eq('org_id', membership.org_id)
    .eq('user_id', targetUserId)
    .single()

  if (targetMember?.role === 'owner') {
    return { error: 'Cannot remove an owner from the organization.' }
  }

  const { error } = await admin
    .from('organization_members')
    .delete()
    .eq('org_id', membership.org_id)
    .eq('user_id', targetUserId)

  if (error) {
    console.error(`[Team:${user.id}] remove member failed:`, error.message)
    return { error: 'Failed to remove member. Please try again.' }
  }

  revalidatePath('/settings/team')
  return { ok: true }
}

export async function revokeInvite(
  inviteId: string
): Promise<{ ok?: true; error?: string }> {
  const { user, membership } = await requireOrgMember()

  if (membership.role !== 'owner') {
    return { error: 'Only the account owner can revoke invitations.' }
  }

  const admin = createServiceClient()
  const { error } = await admin
    .from('org_invites')
    .delete()
    .eq('id', inviteId)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error(`[Team:${user.id}] revoke invite failed:`, error.message)
    return { error: 'Failed to revoke invitation. Please try again.' }
  }

  revalidatePath('/settings/team')
  return { ok: true }
}
