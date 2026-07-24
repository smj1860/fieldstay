'use server'

import { z }                        from 'zod'
import { requireOrgMember }         from '@/lib/auth'
import { createServiceClient, adminFetch } from '@/lib/supabase/server'
import { sendTeamInviteEmail }       from '@/lib/resend/client'
import { revalidatePath }            from 'next/cache'
import { logAuditEvent }             from '@/lib/audit'

const EmailSchema = z.string().email('Invalid email address.')

export async function inviteTeamMember(
  email: string
): Promise<{ ok?: true; error?: string }> {
  try {
    const { user, membership } = await requireOrgMember()

    if (membership.role !== 'owner') {
      return { error: 'Only the account owner can invite team members.' }
    }

    // M-6: Zod email validation
    const parsed = EmailSchema.safeParse(email.trim().toLowerCase())
    if (!parsed.success) return { error: parsed.error.errors[0]?.message ?? 'Invalid email.' }
    const normalizedEmail = parsed.data

    const admin = createServiceClient({ authorizedBy: membership })

    // H-3: Check not already a member using targeted lookup (not listUsers).
    // Supabase admin REST supports GET /auth/v1/admin/users?email=x for point lookups.
    const userLookupRes = await adminFetch(
      `/auth/v1/admin/users?email=${encodeURIComponent(normalizedEmail)}&per_page=1`
    )
    if (userLookupRes.ok) {
      const body = await userLookupRes.json() as { users?: { id: string }[] }
      const existingUserId = body.users?.[0]?.id
      if (existingUserId) {
        const { data: alreadyMember } = await admin
          .from('organization_members')
          .select('id')
          .eq('org_id', membership.org_id)
          .eq('user_id', existingUserId)
          .single()
        if (alreadyMember) {
          return { error: 'This person is already a member of your organization.' }
        }
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
      .select('token, id')
      .single()

    if (insertError || !invite) {
      // code 23505 = unique_violation — concurrent duplicate invite
      if (insertError?.code === '23505') {
        return { error: 'A pending invitation already exists for this email.' }
      }
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
    } catch (_err) {
      console.error(`[Team:${user.id}] invite email failed`)
      // Non-fatal — invite record exists, user can resend
    }

    // M-2: Audit log
    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'team.member.invited',
      targetType: 'invite',
      targetId:   invite.id,
      metadata:   { role: 'admin' },
    })

    revalidatePath('/settings/team')
    return { ok: true }
  } catch (err) {
    console.error('[inviteTeamMember]', err)
    return { error: 'Failed to create invitation. Please try again.' }
  }
}

export async function removeMember(
  targetUserId: string
): Promise<{ ok?: true; error?: string }> {
  try {
    const { user, membership } = await requireOrgMember()

    if (membership.role !== 'owner') {
      return { error: 'Only the account owner can remove team members.' }
    }

    if (targetUserId === user.id) {
      return { error: 'You cannot remove yourself from the organization.' }
    }

    const admin = createServiceClient({ authorizedBy: membership })

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

    // M-2: Audit log
    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'team.member.removed',
      targetType: 'user',
      targetId:   targetUserId,
    })

    revalidatePath('/settings/team')
    return { ok: true }
  } catch (err) {
    console.error('[removeMember]', err)
    return { error: 'Failed to remove member. Please try again.' }
  }
}

export async function revokeInvite(
  inviteId: string
): Promise<{ ok?: true; error?: string }> {
  try {
    const { user, membership } = await requireOrgMember()

    if (membership.role !== 'owner') {
      return { error: 'Only the account owner can revoke invitations.' }
    }

    const admin = createServiceClient({ authorizedBy: membership })
    const { error } = await admin
      .from('org_invites')
      .delete()
      .eq('id', inviteId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error(`[Team:${user.id}] revoke invite failed:`, error.message)
      return { error: 'Failed to revoke invitation. Please try again.' }
    }

    // M-2: Audit log
    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'team.invite.revoked',
      targetType: 'invite',
      targetId:   inviteId,
    })

    revalidatePath('/settings/team')
    return { ok: true }
  } catch (err) {
    console.error('[revokeInvite]', err)
    return { error: 'Failed to revoke invitation. Please try again.' }
  }
}
