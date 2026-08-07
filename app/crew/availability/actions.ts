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
/**
 * The window the crew calendar can navigate to, and therefore the only window
 * a write may target. Exported so app/crew/availability/page.tsx reads exactly
 * the range this action will accept — if they drift, the screen either offers
 * days the action rejects or accepts days it will never show back.
 */
export const LOOKBACK_DAYS  = 30
export const LOOKAHEAD_DAYS = 365

/** crew_availability.notes is free text from a phone keyboard; bound it. */
const MAX_NOTE_LENGTH = 500

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validates the client-supplied date at the boundary.
 *
 * `available_date` was written straight through. A malformed value only earned
 * a Postgres 22007 rendered as the generic catch-all message, and a
 * well-formed but absurd one (the year 3000) was accepted and stored where no
 * screen would ever show it again — invisible to the crew member who set it
 * and to the PM whose time-off check reads a bounded range.
 */
function invalidDateReason(date: string): string | null {
  if (!ISO_DATE_RE.test(date)) return 'That date is not valid. Please reload and try again.'

  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) {
    return 'That date is not valid. Please reload and try again.'
  }
  // Round-trip check: `2026-02-31` matches the regex and Date rolls it over to
  // March 3 rather than rejecting it.
  if (parsed.toISOString().slice(0, 10) !== date) {
    return 'That date is not valid. Please reload and try again.'
  }

  const today = new Date()
  const min   = new Date(today); min.setUTCDate(min.getUTCDate() - LOOKBACK_DAYS)
  const max   = new Date(today); max.setUTCDate(max.getUTCDate() + LOOKAHEAD_DAYS)

  if (parsed < min || parsed > max) {
    return 'That date is outside the window you can request time off for.'
  }
  return null
}

export async function saveCrewAvailability(input: {
  id?:         string
  date:        string
  isAvailable: boolean
  notes:       string | null
}): Promise<{ error?: string }> {
  const auth = await requireCrewMember()
  if (!auth.ok) return { error: 'Could not verify your crew profile. Please reload and try again.' }
  const { supabase, crew } = auth

  const dateProblem = invalidDateReason(input.date)
  if (dateProblem) return { error: dateProblem }

  const trimmed = input.notes?.trim()
  if (trimmed && trimmed.length > MAX_NOTE_LENGTH) {
    return { error: `Please keep the reason under ${MAX_NOTE_LENGTH} characters.` }
  }
  const notes = trimmed ? trimmed : null

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
