'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { logAuditEvent } from '@/lib/audit'

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
  const bathrooms     = formData.get('bathrooms') ? parseFloat(formData.get('bathrooms') as string) : null
  const max_guests    = parseInt(formData.get('max_guests') as string) || 2
  const checkin_time  = formData.get('checkin_time') as string || '15:00'
  const checkout_time = formData.get('checkout_time') as string || '11:00'
  const wifi_name     = (formData.get('wifi_name') as string)?.trim() || null
  const wifi_password = (formData.get('wifi_password') as string)?.trim() || null
  const door_code     = (formData.get('door_code') as string)?.trim() || null
  const internal_notes    = (formData.get('internal_notes') as string)?.trim() || null
  const avg_nightly_rate   = formData.get('avg_nightly_rate')
    ? parseFloat(formData.get('avg_nightly_rate') as string)
    : null
  const cleaning_cost      = formData.get('cleaning_cost')
    ? parseFloat(formData.get('cleaning_cost') as string)
    : null
  const same_day_premium_pct = formData.get('same_day_premium_pct')
    ? parseFloat(formData.get('same_day_premium_pct') as string)
    : null
  const square_footage     = formData.get('square_footage')
    ? parseInt(formData.get('square_footage') as string)
    : null
  const cleaning_cost_visible_to_owner = formData.get('cleaning_cost_visible_to_owner') === 'on'

  if (!name) return { error: 'Property name is required' }

  const { error } = await supabase
    .from('properties')
    .update({
      name, address, city, state, zip, property_type,
      bedrooms, bathrooms, max_guests, checkin_time,
      checkout_time, wifi_name, wifi_password, door_code, internal_notes,
      avg_nightly_rate, cleaning_cost, same_day_premium_pct, square_footage,
      cleaning_cost_visible_to_owner,
    })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[saveDetails]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  // Simplification: logs on every details save (not just when rates actually
  // changed) — fetching before/after values would require an extra query.
  // Future cleanup could compare against pre-update values to only log on
  // real rate changes.
  const { data: { user } } = await supabase.auth.getUser()
  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user?.id,
    action:     'property.rates.updated',
    targetType: 'property',
    targetId:   propertyId,
    metadata: {
      avg_nightly_rate,
      same_day_premium_pct,
    },
  })

  await markStepComplete(propertyId, 'details')
  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}/setup/ical`)
  return {}
}
