import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

export interface CrewAuthContext {
  user:     { id: string }
  supabase: SupabaseServerClient
  crew:     { id: string; org_id: string }
}

export type CrewAuthResult =
  | ({ ok: true } & CrewAuthContext)
  | { ok: false; response: NextResponse }

/**
 * Shared crew-auth pattern for app/api/crew/* Route Handlers.
 *
 * Only filters on is_active — NOT invite_accepted_at. Unlike the
 * requireOrgMember() PM-side check, ~a third of live crew_members rows have
 * invite_accepted_at IS NULL (crew onboarded outside the invite-link flow),
 * so gating on it here would lock out real active crew. is_active is the
 * one signal that reliably reflects "this crew member was offboarded" —
 * deactivateCrewMember() only flips is_active, so this is the check that
 * actually matters for keeping an offboarded crew member's still-valid
 * session from continuing to act.
 */
export async function requireCrewMember(): Promise<CrewAuthResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  }

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .single()

  if (!crew) {
    return { ok: false, response: NextResponse.json({ error: 'Crew member not found' }, { status: 403 }) }
  }

  return { ok: true, user, supabase, crew }
}
