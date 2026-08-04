'use server'

import { revalidatePath } from 'next/cache'
import { requireCrewMember } from '@/lib/crew-auth'
import { reportError } from '@/lib/observability/report-error'

/**
 * Time-off is deliberately NOT offline-capable.
 *
 * It used to write through the Dexie cache and the mutation outbox like a
 * checklist tick, which meant the crew PWA pulled every crew member's own
 * availability window — up to a year forward — into IndexedDB on every safety
 * poll, forever, to back a screen nobody opens at a property with no signal.
 * Requesting time off is a deliberate, low-frequency action taken somewhere
 * with a connection; there is no "I did the work and must not lose it"
 * property to protect, and a failed request is simply retried by the person
 * making it.
 *
 * Note what this also fixes: org_id and crew_member_id now come from the
 * authenticated crew context, not from props the client passed in.
 */
export async function saveCrewAvailability(input: {
  id?:         string
  date:        string
  isAvailable: boolean
  notes:       string | null
}): Promise<{ error?: string }> {
  const auth = await requireCrewMember()
  if (!auth.ok) return { error: 'Could not verify your crew profile. Please reload and try again.' }
  const { supabase, crew } = auth

  const notes = input.notes?.trim() ? input.notes.trim() : null

  try {
    if (input.id) {
      // Scoped to this crew member's own row — an id from the client proves
      // nothing on its own.
      const { data, error } = await supabase
        .from('crew_availability')
        .update({ is_available: input.isAvailable, notes })
        .eq('id', input.id)
        .eq('crew_member_id', crew.id)
        .select('id')
        .maybeSingle()

      if (error) throw error
      if (!data) return { error: 'That day is no longer on your calendar. Please reload.' }
    } else {
      const { error } = await supabase
        .from('crew_availability')
        .upsert(
          {
            org_id:         crew.org_id,
            crew_member_id: crew.id,
            available_date: input.date,
            is_available:   input.isAvailable,
            notes,
          },
          { onConflict: 'crew_member_id,available_date' },
        )

      if (error) throw error
    }

    revalidatePath('/crew/availability')
    return {}
  } catch (err) {
    console.error('[saveCrewAvailability]', err)
    reportError(err, { site: 'serverAction.crew.availability.save', orgId: crew.org_id })
    return { error: 'Could not save that change. Check your connection and try again.' }
  }
}
