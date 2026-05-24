'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'

export type IcalState = { error?: string; success?: boolean }

export async function addIcalFeed(
  propertyId: string,
  _prev: IcalState | null,
  formData: FormData
): Promise<IcalState> {
  const { supabase, membership } = await requireOrgMember()

  const name   = (formData.get('name') as string)?.trim()
  const url    = (formData.get('url') as string)?.trim()
  const source = formData.get('source') as string || 'other'

  if (!name) return { error: 'Feed name is required' }
  if (!url)  return { error: 'Calendar URL is required' }
  if (!url.startsWith('http')) return { error: 'Please enter a valid URL' }

  const { error } = await supabase.from('ical_feeds').insert({
    property_id: propertyId,
    org_id:      membership.org_id,
    name, url, source,
  })

  if (error) return { error: error.message }

  revalidatePath(`/properties/${propertyId}/setup/ical`)
  return { success: true }
}

export async function deleteIcalFeed(feedId: string, propertyId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()
  await supabase
    .from('ical_feeds')
    .delete()
    .eq('id', feedId)
    .eq('org_id', membership.org_id)
  revalidatePath(`/properties/${propertyId}/setup/ical`)
}

export async function completeIcalStep(propertyId: string): Promise<void> {
  await markStepComplete(propertyId, 'ical')
  redirect(`/properties/${propertyId}/setup/inventory`)
}
