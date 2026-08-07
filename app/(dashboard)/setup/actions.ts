'use server'

import { redirect, unstable_rethrow } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireOrgRole } from '@/lib/auth'
import { reportQueryError } from '@/lib/supabase/unwrap'
import { ONBOARDING_STEPS } from '@/lib/onboarding-wizard'

import { reportError } from '@/lib/observability/report-error'

/**
 * Records one setup-wizard step as done and moves the user on.
 *
 * ⚠️ The role gate is load-bearing, and it must match the DATABASE, not just
 * feel reasonable. `organizations`' RLS UPDATE policy is
 * `is_org_member(id, ARRAY['admin'::member_role])` — admin and owner only.
 * This used to run under requireOrgMember(), so ANY member could call it, and
 * it discarded the UPDATE result. For a manager (or viewer, or anyone else)
 * the write matched zero rows — which under RLS is not an error, just an empty
 * result — and the action then redirected to the next step as though it had
 * saved. Nothing was written, nothing was logged, and /setup recomputes the
 * current step from the database, so returning to it sent them back to step
 * one. Every one of the eight steps behaved this way: a non-admin could walk
 * the whole wizard and never complete a single step.
 *
 * That was not merely cosmetic. app/(dashboard)/layout.tsx force-redirects
 * every member of an org with zero completed steps to /setup, so a manager
 * invited before the owner finished step 1 was locked to /setup, /settings,
 * /help and /billing-wall with no way out and no error to report.
 *
 * requireOrgRole(['admin']) mirrors is_org_member exactly — it passes 'owner'
 * unconditionally — so the app-level gate and the policy can no longer
 * disagree. The layout and the sidebar were changed in the same pass so a
 * non-admin is never sent here to begin with.
 */
export async function markStepComplete(
  stepKey: string,
  nextHref?: string
): Promise<void> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin'])

    const orgRes = await supabase
      .from('organizations')
      .select('onboarding_steps_completed')
      .eq('id', membership.org_id)
      .single()

    if (reportQueryError(orgRes.error, { site: 'serverAction.setup.markStepComplete.read', orgId: membership.org_id })) {
      throw new Error('Could not load your setup progress. Please try again.')
    }

    // Read-modify-write on a jsonb column, so two steps completed at the same
    // instant would lose one. Left as-is deliberately: the wizard is linear and
    // a step is completed by a single click on a single page, so the only way
    // to reach it is two tabs mid-wizard. Merging server-side (a jsonb ||
    // expression) needs an RPC, which is more machinery than the window
    // justifies — but it is a real window, so it is written down rather than
    // pretended away.
    const completed = { ...(orgRes.data?.onboarding_steps_completed ?? {}) as Record<string, boolean>, [stepKey]: true }

    const { data: updated, error: updateError } = await supabase
      .from('organizations')
      .update({ onboarding_steps_completed: completed })
      .eq('id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (updateError) {
      console.error('[markStepComplete]', updateError)
      reportError(updateError, { site: 'serverAction.setup.markStepComplete.update', orgId: membership.org_id })
      throw new Error('Could not save your setup progress. Please try again.')
    }

    // No error AND no row is the RLS-denial shape — the case that used to sail
    // straight through to the redirect below. It must never be silent again:
    // the whole defect was a write that reported success while saving nothing.
    if (!updated) {
      const denial = new Error(`markStepComplete wrote no row for org ${membership.org_id} (step ${stepKey})`)
      reportError(denial, { site: 'serverAction.setup.markStepComplete.denied', orgId: membership.org_id })
      throw new Error('Could not save your setup progress. Please try again.')
    }

    revalidatePath('/setup')

    if (nextHref) {
      redirect(nextHref)
    } else {
      // Find next incomplete step
      const next = ONBOARDING_STEPS.find((s) => !completed[s.key])
      if (next) {
        redirect(`/setup/${next.href}`)
      } else {
        redirect('/ops')
      }
    }
  } catch (err) {
    unstable_rethrow(err)
    console.error('[markStepComplete]', err)
    reportError(err, { site: 'serverAction.setup.markStepComplete' })
    throw err
  }
}
