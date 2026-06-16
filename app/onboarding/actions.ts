'use server'

import { redirect } from 'next/navigation'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { slugify } from '@/lib/utils'

export type OnboardingState = { error?: string }

export async function createOrganization(
  _prev: OnboardingState | null,
  formData: FormData
): Promise<OnboardingState> {
  // Verify identity with regular client
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const name = (formData.get('org_name') as string)?.trim()
  if (!name) return { error: 'Organization name is required' }

  // Use service client for inserts — user identity already verified above
  const admin = createServiceClient()

  // Pre-flight: prevent duplicate orgs from double-submit
  const { count: memberCount } = await admin
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)

  if ((memberCount ?? 0) > 0) redirect('/ops')

  let slug = slugify(name)
  const { count } = await admin
    .from('organizations')
    .select('id', { count: 'exact', head: true })
    .eq('slug', slug)
  if ((count ?? 0) > 0) slug = `${slug}-${Date.now().toString(36)}`

  const { data: org, error } = await admin
    .from('organizations')
    .insert({
      name,
      slug,
      billing_email: user.email,
      plan: 'starter',
      plan_status: 'trialing',
      trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      max_properties: 15,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[createOrganization]', error)
    return { error: 'Failed to create organization. Please try again.' }
  }

  await admin.from('organization_members').insert({
    org_id:             org.id,
    user_id:            user.id,
    role:               'owner',
    invite_accepted_at: new Date().toISOString(),
  })

  await inngest.send({
    name: 'org/created',
    data: {
      org_id:     org.id,
      user_id:    user.id,
      org_name:   name,
      user_email: user.email ?? '',
      first_name: (user.user_metadata?.full_name as string | undefined)
        ?.split(' ')[0] ?? 'there',
    },
  })

  redirect('/setup')
  return {}
}
