'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'

export type DetailsState = { error?: string; success?: boolean }

export async function saveDetails(
  propertyId: string,
  _prev: DetailsState | null,
  formData: FormData
): Promise<DetailsState> {
  const { supabase, membership } = await requireOrgMember()

  const name          = (formData.get('name') as string)?.trim()
  const address       = (formData.get('address') as string)?.trim() || null
  const city          = (formData.get('city') as string)?.trim() || null
  const state         = (formData.get('state') as string)?.trim() || null
  const zip           = (formData.get('zip') as string)?.trim() || null
  const property_type = formData.get('property_type') as string || 'house'
  const bedrooms      = parseInt(formData.get('bedrooms') as string) || 1
  const bathrooms     = parseFloat(formData.get('bathrooms') as string) || 1
  const max_guests    = parseInt(formData.get('max_guests') as string) || 2
  const checkin_time  = formData.get('checkin_time') as string || '15:00'
  const checkout_time = formData.get('checkout_time') as string || '11:00'
  const wifi_name     = (formData.get('wifi_name') as string)?.trim() || null
  const wifi_password = (formData.get('wifi_password') as string)?.trim() || null
  const door_code     = (formData.get('door_code') as string)?.trim() || null
  const internal_notes    = (formData.get('internal_notes') as string)?.trim() || null
  const avg_nightly_rate  = formData.get('avg_nightly_rate')
    ? parseFloat(formData.get('avg_nightly_rate') as string)
    : null

  if (!name) return { error: 'Property name is required' }

  const { error } = await supabase
    .from('properties')
    .update({
      name, address, city, state, zip, property_type,
      bedrooms, bathrooms, max_guests, checkin_time,
      checkout_time, wifi_name, wifi_password, door_code, internal_notes,
      avg_nightly_rate,
    })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  await markStepComplete(propertyId, 'details')
  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}/setup/ical`)
}
