import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'

export async function acceptOrgInvite(
  userId: string,
  userEmail: string,
  inviteToken: string
): Promise<{ accepted: boolean; orgId?: string }> {
  const admin = createServiceClient({ system: 'lib/auth/invites' })

  const { data: invite } = await admin
    .from('org_invites')
    .select('id, org_id, email, role, expires_at')
    .eq('token', inviteToken)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (!invite) return { accepted: false }
  if (invite.email.toLowerCase() !== userEmail.toLowerCase()) return { accepted: false }

  // Crew are onboarded through /crew-invite, which creates a crew_members row
  // and NO organization_members row. That distinction is load-bearing: the
  // SELECT policies in 20260723090000_drop_redundant_is_org_member_from_select_
  // policies.sql grant every accepted org member read access to the whole org's
  // turnovers, bookings (incl. guest_name/guest_email), and work_orders. Crew
  // are scoped instead by the get_crew_turnover_ids() branch, which only works
  // because they hold no membership row. Accepting a crew-role org invite would
  // silently hand a cleaner portfolio-wide guest PII. Refuse it here.
  if (invite.role === 'crew') {
    console.error(
      `[acceptOrgInvite] Refused crew-role org invite ${invite.id} — crew must onboard via /crew-invite`,
    )
    return { accepted: false }
  }

  // Claim the invite FIRST, atomically. The select above filtered on
  // `.is('accepted_at', null)`, but that read is not a lock — two concurrent
  // redemptions of the same token both pass it. The `.is('accepted_at', null)`
  // in this UPDATE's WHERE clause is the real guard: exactly one of the racing
  // statements matches a row, and `.select()` tells us which one won. Same
  // pattern as the turnover-completion race guard in
  // app/api/crew/turnovers/[id]/complete/route.ts.
  const { data: claimed, error: claimError } = await admin
    .from('org_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id)
    .is('accepted_at', null)
    .select('id')
    .maybeSingle()

  if (claimError) {
    console.error(`[acceptOrgInvite] invite claim failed for invite ${invite.id}:`, claimError)
    return { accepted: false }
  }
  // Lost the race (or the invite was accepted between the read and here) —
  // do NOT create a membership off an invite we did not claim.
  if (!claimed) return { accepted: false }

  const { error: insertError } = await admin.from('organization_members').insert({
    org_id:             invite.org_id,
    user_id:            userId,
    role:               invite.role,
    invite_accepted_at: new Date().toISOString(),
  })

  if (insertError) {
    // 23505 = unique_violation on organization_members_org_id_user_id_key.
    // The membership this invite was meant to create already exists, so the
    // caller's post-condition ("this user is a member of this org") holds —
    // benign, treat as success.
    if (insertError.code !== '23505') {
      // Roll the claim back so the invite stays redeemable — the caller
      // (app/accept-invite/[token]/actions.ts) deletes the auth user it just
      // created when accepted is false, and a permanently-consumed invite
      // with no membership row would lock the invitee out for good.
      const { error: unclaimError } = await admin
        .from('org_invites')
        .update({ accepted_at: null })
        .eq('id', invite.id)

      if (unclaimError) {
        console.error(
          `[acceptOrgInvite] failed to release invite ${invite.id} after membership insert error:`,
          unclaimError,
        )
      }

      console.error(
        `[acceptOrgInvite] membership insert failed for invite ${invite.id}:`,
        insertError,
      )
      return { accepted: false }
    }
  }

  // No invitee email in metadata — audit_events.metadata must never carry PII
  // (CLAUDE.md). actorId already identifies the user.
  await logAuditEvent({
    orgId:      invite.org_id,
    actorId:    userId,
    action:     'auth.invite.accepted',
    targetType: 'org_invite',
    targetId:   invite.id,
    metadata:   { role: invite.role },
  })

  return { accepted: true, orgId: invite.org_id }
}
