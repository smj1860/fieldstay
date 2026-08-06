import { requireAuth } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { logAuditEvent } from '@/lib/audit'
import { redirect } from 'next/navigation'
import { OnboardingForm } from './onboarding-form'

interface Props {
  searchParams: Promise<{ invite?: string }>
}

export default async function OnboardingPage({ searchParams }: Readonly<Props>) {
  const { user } = await requireAuth()
  // Both invite-acceptance call sites redirect here with ?invite=invalid when
  // acceptOrgInvite returns false, rather than dropping the user on "Name your
  // organization" with no explanation — see the note on OnboardingForm's
  // inviteFailed prop.
  const inviteFailed = (await searchParams).invite === 'invalid'

  // ── Crew-member guard ──────────────────────────────────────────────────────
  // A crew member has a crew_members.user_id record but no organization_members
  // row. If one lands here (e.g. via a back-button or stale URL), redirect them
  // before any onboarding logic runs.
  const admin = createServiceClient({ authenticatedUser: user })

  // .limit(1) before .maybeSingle(), and the error is handled — all three reads
  // on this page used the bare `const { data } = ... .maybeSingle()` shape,
  // which fails in two directions at once. maybeSingle() ERRORS (PGRST116) when
  // more than one row matches, and none of these three relations is actually
  // one-per-user: a person can be crew at two orgs, a PM can belong to several
  // orgs (get_user_org_ids() returns a set, plural, by design), and an org can
  // hold more than one active integration_connection. Discarding the error then
  // turned that into `data === null`, i.e. the exact same answer as "no row" —
  // so a legitimately multi-org PM would be shown the create-an-organization
  // form again, and an org with two connected providers would be asked to
  // connect a PMS it had already connected.
  const crewRes = await admin
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  throwIfAnyQueryFailed({ site: 'page.onboarding.crew' }, crewRes.error)
  const crewRecord = crewRes.data

  if (crewRecord) {
    await logAuditEvent({
      actorId:    user.id,
      action:     'security.route.mismatch',
      targetType: 'route',
      targetId:   '/onboarding',
      metadata: {
        crew_member_id: crewRecord.id,
        org_id:         crewRecord.org_id,
        reason:         'crew_member_reached_pm_onboarding',
      },
    })
    redirect('/crew')
  }
  // ── End crew-member guard ──────────────────────────────────────────────────

  // ── Resume-in-progress guard ────────────────────────────────────────────────
  // If this user already has an org (step 1 already completed — e.g. they
  // refreshed or navigated away mid-flow), don't make them re-submit the
  // name form. Skip straight to whichever step is actually still pending.
  const membershipRes = await admin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  throwIfAnyQueryFailed({ site: 'page.onboarding.membership' }, membershipRes.error)
  const membership = membershipRes.data

  if (membership) {
    const connectionRes = await admin
      .from('integration_connections')
      .select('id')
      .eq('org_id', membership.org_id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()

    throwIfAnyQueryFailed({ site: 'page.onboarding.connection', orgId: membership.org_id }, connectionRes.error)
    const connection = connectionRes.data

    // Org exists and a PMS is already connected — onboarding is fully
    // done, nothing left for this page to do.
    if (connection) redirect('/ops')

    // Org exists but no PMS connected yet — resume at step 2 directly.
    return <OnboardingForm userEmail={user.email ?? ''} initialStep="connect-pms" inviteFailed={inviteFailed} />
  }
  // ── End resume-in-progress guard ────────────────────────────────────────────

  return <OnboardingForm userEmail={user.email ?? ''} inviteFailed={inviteFailed} />
}
