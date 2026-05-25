'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireOrgMember } from '@/lib/auth'
import { slugify } from '@/lib/utils'

export type PropertyActionState = {
  error?: string
  fieldErrors?: Record<string, string>
  success?: boolean
}

// ── Create ──────────────────────────────────────────────────

export async function createProperty(
  _prev: PropertyActionState | null,
  formData: FormData
): Promise<PropertyActionState> {
  const { supabase, membership } = await requireOrgMember()

  const name          = (formData.get('name') as string)?.trim()
  const address       = (formData.get('address') as string)?.trim()
  const city          = (formData.get('city') as string)?.trim()
  const state         = (formData.get('state') as string)?.trim()
  const zip           = (formData.get('zip') as string)?.trim()
  const property_type = formData.get('property_type') as string || 'house'
  const bedrooms      = parseInt(formData.get('bedrooms') as string) || 1
  const bathrooms     = parseFloat(formData.get('bathrooms') as string) || 1
  const max_guests    = parseInt(formData.get('max_guests') as string) || 2
  const checkin_time  = (formData.get('checkin_time') as string) || '15:00'
  const checkout_time = (formData.get('checkout_time') as string) || '11:00'
  const wifi_name     = (formData.get('wifi_name') as string)?.trim() || null
  const wifi_password = (formData.get('wifi_password') as string)?.trim() || null
  const door_code        = (formData.get('door_code') as string)?.trim() || null
  const internal_notes   = (formData.get('internal_notes') as string)?.trim() || null
  const avg_nightly_rate = formData.get('avg_nightly_rate')
    ? parseFloat(formData.get('avg_nightly_rate') as string)
    : null

  if (!name) return { error: 'Property name is required' }

  // Check plan property limit
  const { count } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', membership.org_id)
    .eq('is_active', true)

  if ((count ?? 0) >= membership.org.max_properties) {
    return {
      error: `Your plan allows up to ${membership.org.max_properties} properties. Upgrade to add more.`,
    }
  }

  const { data: property, error } = await supabase
    .from('properties')
    .insert({
      org_id:         membership.org_id,
      name,
      address:        address || null,
      city:           city || null,
      state:          state || null,
      zip:            zip || null,
      property_type,
      bedrooms,
      bathrooms,
      max_guests,
      checkin_time,
      checkout_time,
      wifi_name,
      wifi_password,
      door_code,
      internal_notes,
      avg_nightly_rate,
      setup_steps_completed: { details: true },
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  revalidatePath('/properties')
  redirect(`/properties/${property.id}/setup/ical`)
}

// ── Update ───────────────────────────────────────────────────

export async function updateProperty(
  propertyId: string,
  _prev: PropertyActionState | null,
  formData: FormData
): Promise<PropertyActionState> {
  const { supabase, membership } = await requireOrgMember()

  const name          = (formData.get('name') as string)?.trim()
  const address       = (formData.get('address') as string)?.trim()
  const city          = (formData.get('city') as string)?.trim()
  const state         = (formData.get('state') as string)?.trim()
  const zip           = (formData.get('zip') as string)?.trim()
  const property_type = formData.get('property_type') as string || 'house'
  const bedrooms      = parseInt(formData.get('bedrooms') as string) || 1
  const bathrooms     = parseFloat(formData.get('bathrooms') as string) || 1
  const max_guests    = parseInt(formData.get('max_guests') as string) || 2
  const checkin_time  = (formData.get('checkin_time') as string) || '15:00'
  const checkout_time = (formData.get('checkout_time') as string) || '11:00'
  const wifi_name     = (formData.get('wifi_name') as string)?.trim() || null
  const wifi_password = (formData.get('wifi_password') as string)?.trim() || null
  const door_code     = (formData.get('door_code') as string)?.trim() || null
  const internal_notes = (formData.get('internal_notes') as string)?.trim() || null

  if (!name) return { error: 'Property name is required' }

  const { error } = await supabase
    .from('properties')
    .update({
      name, address: address || null, city: city || null,
      state: state || null, zip: zip || null,
      property_type, bedrooms, bathrooms, max_guests,
      checkin_time, checkout_time, wifi_name,
      wifi_password, door_code, internal_notes,
    })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath(`/properties/${propertyId}`)
  return { success: true }
}

// ── Mark step complete ────────────────────────────────────────

export async function markStepComplete(
  propertyId: string,
  step: string
): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

  // Fetch current steps
  const { data } = await supabase
    .from('properties')
    .select('setup_steps_completed')
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)
    .single()

  const current = (data?.setup_steps_completed as Record<string, boolean>) ?? {}
  const updated  = { ...current, [step]: true }

  await supabase
    .from('properties')
    .update({ setup_steps_completed: updated })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  const allSteps = ['details', 'ical', 'inventory', 'messages', 'checklist', 'maintenance', 'crew']
  const isFullySetup = allSteps.every((s) => updated[s] === true)

  if (isFullySetup) {
    const { data: props } = await supabase
      .from('properties')
      .select('id, setup_steps_completed')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)

    const fullyConfigured = (props ?? []).filter((p) => {
      const steps = p.setup_steps_completed as Record<string, boolean>
      return allSteps.every((s) => steps?.[s] === true)
    })

    if (fullyConfigured.length === 2) {
      await supabase.from('org_milestones').upsert(
        { org_id: membership.org_id, milestone: 'second_property_configured' },
        { onConflict: 'org_id,milestone', ignoreDuplicates: true }
      )
    }
  }

  revalidatePath(`/properties/${propertyId}`)
}

// ── Archive ──────────────────────────────────────────────────

export async function archiveProperty(propertyId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

  await supabase
    .from('properties')
    .update({ is_active: false })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  revalidatePath('/properties')
  redirect('/properties')
}
