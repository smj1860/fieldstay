'use server'

import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/auth'
import { slugify } from '@/lib/utils'

export type OnboardingState = { error?: string }

export async function createOrganization(
  _prev: OnboardingState | null,
  formData: FormData
): Promise<OnboardingState> {
  const { user, supabase } = await requireAuth()
  const name = (formData.get('org_name') as string)?.trim()
  if (!name) return { error: 'Organization name is required' }

  let slug = slugify(name)
  const { count } = await supabase
    .from('organizations')
    .select('id', { count: 'exact', head: true })
    .eq('slug', slug)
  if ((count ?? 0) > 0) slug = `${slug}-${Date.now().toString(36)}`

  const { data: org, error } = await supabase
    .from('organizations')
    .insert({
      name,
      slug,
      billing_email: user.email,
      plan: 'starter',
      plan_status: 'trialing',
      trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      max_properties: 5,
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  await supabase.from('organization_members').insert({
    org_id: org.id,
    user_id: user.id,
    role: 'admin',
    invite_accepted_at: new Date().toISOString(),
  })

  redirect('/properties/new')
}
