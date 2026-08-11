'use server'

import { nullableArg } from '@/lib/supabase/rpc-args'
import { redirect, unstable_rethrow } from 'next/navigation'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { slugify } from '@/lib/utils'

import { reportError } from '@/lib/observability/report-error'
export type OnboardingState = { error?: string; success?: boolean }

export async function createOrganization(
  _prev: OnboardingState | null,
  formData: FormData
): Promise<OnboardingState> {
  try {
    // Verify identity with regular client
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) redirect('/login')

    const name = (formData.get('org_name') as string)?.trim()
    if (!name) return { error: 'Organization name is required' }

    // Use service client for inserts — user identity already verified above
    const admin = createServiceClient({ authenticatedUser: user })

    let slug = slugify(name)
    const { count } = await admin
      .from('organizations')
      .select('id', { count: 'exact', head: true })
      .eq('slug', slug)
    if ((count ?? 0) > 0) slug = `${slug}-${Date.now().toString(36)}`

    // The membership pre-check and the org/membership inserts run inside a
    // single Postgres function (advisory-locked per user_id) so a double-submit
    // can't have two concurrent requests both pass the check and each create a
    // duplicate organization — see create_organization_with_owner migration.
    const { data, error } = await admin
      .rpc('create_organization_with_owner', {
        p_user_id:        user.id,
        p_name:           name,
        p_slug:           slug,
        // organizations.billing_email is nullable and so is this parameter.
        p_billing_email:  nullableArg(user.email ?? null),
        p_max_properties: 15,
        p_trial_ends_at:  new Date(Date.now() + 14 * 86_400_000).toISOString(),
      })
      .single()

    if (error) {
      console.error('[createOrganization]', error)
      return { error: 'Failed to create organization. Please try again.' }
    }

    const result = data as { org_id: string; created: boolean }
    if (!result.created) redirect('/ops')

    // Both sends in one call so a transient Inngest failure can't leave the
    // drip scheduled but the inventory bootstrap dropped (or the reverse).
    //
    // organization/created carries only ids: bootstrap-new-org-inventory
    // resolves the standard template and seeds the org's catalog copy itself,
    // deliberately off this request path. Seeding copies the whole platform
    // catalog a page at a time, and neither half should be able to fail
    // account creation — the user is waiting on this redirect.
    await inngest.send([
      // Sends the welcome email immediately and schedules the rest.
      {
        name: 'user/onboarding.drip.started',
        data: {
          user_id:    user.id,
          org_id:     result.org_id,
          first_name: (user.user_metadata?.full_name as string | undefined)
            ?.split(' ')[0] ?? 'there',
          email:      user.email ?? '',
          org_name:   name,
        },
      },
      {
        name: 'organization/created',
        data: { org_id: result.org_id, user_id: user.id },
      },
    ])

    return { success: true }
  } catch (err) {
    unstable_rethrow(err)
    console.error('[createOrganization]', err)
    reportError(err, { site: 'serverAction.onboarding.createOrganization' })
    return { error: 'Failed to create organization. Please try again.' }
  }
}
