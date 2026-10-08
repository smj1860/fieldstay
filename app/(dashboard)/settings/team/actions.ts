'use server'

import { z }                        from 'zod'
import { checkLimit, emailSendActionLimiter } from '@/lib/rate-limit'
import { requireOrgMember }         from '@/lib/auth'
import { createServiceClient, adminFetch } from '@/lib/supabase/server'
import { sendTeamInviteEmail }       from '@/lib/resend/client'
import { revalidatePath }            from 'next/cache'
import { logAuditEvent }             from '@/lib/audit'
import { tryUnwrap, throwIfAnyQueryFailed, isRealQueryError } from '@/lib/supabase/unwrap'

import { reportError } from '@/lib/observability/report-error'
const EmailSchema = z.string().email('Invalid email address.')

/**
 * The roles the invite form can hand out.
 *
 * 'admin' is what every invite was before this, hardcoded. 'finance' is a
 * bookkeeper: /billing and nothing else in their nav (see migration
 * 20260930120000). 'operations' and 'maintenance' are the inverse: all the
 * operational work and none of the billing, integrations or team management
 * (20261008120000). Deliberately NOT the whole member_role enum — 'owner' is
 * not transferable through an invite, 'crew' is refused downstream by
 * acceptOrgInvite() because a crew member must hold no organization_members
 * row at all, and 'manager'/'viewer' have never had an invite path, so
 * opening one for them is its own change with its own copy to write.
 */
const INVITABLE_ROLES = ['admin', 'operations', 'maintenance', 'finance'] as const
export type InvitableRole = (typeof INVITABLE_ROLES)[number]
const RoleSchema = z.enum(INVITABLE_ROLES)

// H-3: check not already a member using a targeted lookup (not listUsers).
// Supabase admin REST supports GET /auth/v1/admin/users?email=x for point
// lookups. Split out of inviteTeamMember so its own nested "found a user ->
// check membership -> already a member" chain has its own complexity budget.
async function findAlreadyMemberError(
  admin: ReturnType<typeof createServiceClient>,
  orgId: string,
  normalizedEmail: string,
): Promise<string | null> {
  const userLookupRes = await adminFetch(
    `/auth/v1/admin/users?email=${encodeURIComponent(normalizedEmail)}&per_page=1`
  )
  if (!userLookupRes.ok) return null

  const body = await userLookupRes.json() as { users?: { id: string }[] }
  const existingUserId = body.users?.[0]?.id
  if (!existingUserId) return null

  const { data: alreadyMember, error: alreadyMemberError } = await admin
    .from('organization_members')
    .select('id')
    .eq('org_id', orgId)
    .eq('user_id', existingUserId)
    .single()
  throwIfAnyQueryFailed(
    { site: 'serverAction.team.inviteTeamMember.alreadyMember', orgId },
    isRealQueryError(alreadyMemberError) ? alreadyMemberError : null,
  )

  return alreadyMember ? 'This person is already a member of your organization.' : null
}

export async function inviteTeamMember(
  email: string,
  role: InvitableRole = 'admin',
): Promise<{ ok?: true; error?: string }> {
  try {
    const { user, membership } = await requireOrgMember()

    if (membership.role !== 'owner') {
      return { error: 'Only the account owner can invite team members.' }
    }

    // Rate limit AFTER the authorization check: an unauthorized caller must not
    // consume another user's budget, and must get the authorization error rather
    // than a throttling one. An auth gate proves WHO is sending, not HOW OFTEN —
    // without this one member can drive unlimited outbound mail from our sending
    // domain, which risks the domain's reputation using someone else's address
    // as the target. Fails OPEN: an abuse limiter must not block real invites
    // during a Redis outage.
    const rl = await checkLimit(emailSendActionLimiter, `invite-team:${user.id}`, {
      onError: 'allow',
      site:    'serverAction.team.inviteTeamMember',
    })
    if (!rl.allowed) return { error: 'Too many invites sent. Please try again in a little while.' }

    // M-6: Zod email validation
    const parsed = EmailSchema.safeParse(email.trim().toLowerCase())
    if (!parsed.success) return { error: parsed.error.errors[0]?.message ?? 'Invalid email.' }
    const normalizedEmail = parsed.data

    // Validated rather than trusted: this is a client-supplied value that
    // becomes a member_role on a row, and the allowlist is what stops it
    // being 'owner'.
    const parsedRole = RoleSchema.safeParse(role)
    if (!parsedRole.success) return { error: 'Pick a role for this teammate.' }
    const inviteRole = parsedRole.data

    const admin = createServiceClient({ authorizedBy: membership })

    const alreadyMemberError = await findAlreadyMemberError(admin, membership.org_id, normalizedEmail)
    if (alreadyMemberError) return { error: alreadyMemberError }

    // Check no active pending invite
    const { data: existingInvite, error: existingInviteError } = await admin
      .from('org_invites')
      .select('id')
      .eq('org_id', membership.org_id)
      .eq('email', normalizedEmail)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .single()
    throwIfAnyQueryFailed(
      { site: 'serverAction.team.inviteTeamMember.existingInvite', orgId: membership.org_id },
      isRealQueryError(existingInviteError) ? existingInviteError : null,
    )

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
        role:       inviteRole,
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
      reportError(_err, { site: 'serverAction.settings.team.inviteTeamMember' })
      // Non-fatal — invite record exists, user can resend
    }

    // M-2: Audit log
    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'team.member.invited',
      targetType: 'invite',
      targetId:   invite.id,
      metadata:   { role: inviteRole },
    })

    revalidatePath('/settings/team')
    return { ok: true }
  } catch (err) {
    console.error('[inviteTeamMember]', err)
    reportError(err, { site: 'serverAction.settings.team.inviteTeamMember' })
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

    // Prevent removing another owner.
    //
    // This read is the ONLY thing enforcing that rule, so its error can't be
    // discarded. `const { data: targetMember }` collapsed three outcomes into
    // one undefined — "they're an owner" never reached the guard, "they aren't
    // a member of this org at all" looked identical to "they're a removable
    // member", and a transient failure of the read itself let the delete
    // proceed against an owner. Nothing downstream would have caught it: the
    // delete below is org-scoped but role-blind, and a delete matching zero
    // rows returns no error, so the action reported success and wrote an audit
    // row for a removal that never happened.
    //
    // maybeSingle, not single: a non-member must be distinguishable from a
    // failed lookup, and .single() reports both as an error.
    const targetRes = await admin
      .from('organization_members')
      .select('role')
      .eq('org_id', membership.org_id)
      .eq('user_id', targetUserId)
      .maybeSingle()

    const targetOut = tryUnwrap(targetRes, {
      site:  'serverAction.settings.team.removeMember.targetLookup',
      orgId: membership.org_id,
    })

    if (!targetOut.ok) {
      return { error: 'Could not verify that member right now. Please try again.' }
    }
    if (!targetOut.data) {
      return { error: 'That person is not a member of your organization.' }
    }
    if (targetOut.data.role === 'owner') {
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
    reportError(err, { site: 'serverAction.settings.team.removeMember' })
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
    reportError(err, { site: 'serverAction.settings.team.revokeInvite' })
    return { error: 'Failed to revoke invitation. Please try again.' }
  }
}
