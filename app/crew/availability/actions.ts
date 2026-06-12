'use server'

import { createClient } from '@/lib/supabase/server'

export type AvailabilityDay = {
  available_date: string
  is_available:   boolean
  notes:          string | null
}

export type SetAvailabilityResult = { success?: boolean; error?: string }

async function requireCrewMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .not('invite_accepted_at', 'is', null)
    .single()
  if (!crew) throw new Error('Crew member not found')

  return { supabase, crew }
}

export async function getMyAvailability(startDate: string, endDate: string): Promise<AvailabilityDay[]> {
  const { supabase, crew } = await requireCrewMember()

  const { data } = await supabase
    .from('crew_availability')
    .select('available_date, is_available, notes')
    .eq('crew_member_id', crew.id)
    .gte('available_date', startDate)
    .lte('available_date', endDate)

  return data ?? []
}

// Pass `isAvailable: null` to clear the entry and return the day to its default (no preference) state
export async function setCrewAvailability(
  date: string,
  isAvailable: boolean | null,
  notes?: string | null,
): Promise<SetAvailabilityResult> {
  try {
    const { supabase, crew } = await requireCrewMember()

    if (isAvailable === null) {
      const { error } = await supabase
        .from('crew_availability')
        .delete()
        .eq('crew_member_id', crew.id)
        .eq('available_date', date)
      if (error) {
        console.error('[setCrewAvailability:delete]', error)
        return { error: 'Operation failed. Please try again.' }
      }
      return { success: true }
    }

    const { error } = await supabase
      .from('crew_availability')
      .upsert(
        {
          org_id:         crew.org_id,
          crew_member_id: crew.id,
          available_date: date,
          is_available:   isAvailable,
          notes:          notes ?? null,
        },
        { onConflict: 'crew_member_id,available_date' }
      )
    if (error) {
      console.error('[setCrewAvailability]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    return { success: true }
  } catch (err) {
    console.error('[setCrewAvailability]', err)
    return { error: 'Failed to update availability' }
  }
}
