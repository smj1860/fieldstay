'use server'

import { revalidatePath } from 'next/cache'
import { requireCrewMember } from '@/lib/crew-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import type { CrewLocale } from '@/types/database'

/**
 * crew_members' UPDATE RLS policy is admin/manager-only (is_org_member),
 * so a plain 'crew' role member cannot flip their own locale through the
 * RLS-scoped client the way saveCrewAvailability writes crew_availability.
 * Scoped explicitly with .eq('id', crew.id) — see
 * supabase/migrations/20260910125639_add_crew_members_locale.sql for why
 * this route was chosen over a narrowed self-update grant + policy.
 */
export async function setCrewLocale(locale: CrewLocale): Promise<{ error?: string }> {
  const auth = await requireCrewMember()
  if (!auth.ok) return { error: 'Could not verify your crew profile. Please reload and try again.' }
  const { crew } = auth

  try {
    const service = createServiceClient({ crew })
    const { error } = await service
      .from('crew_members')
      .update({ locale })
      .eq('id', crew.id)

    if (error) throw error

    revalidatePath('/crew', 'layout')
    return {}
  } catch (err) {
    console.error('[setCrewLocale]', err)
    reportError(err, { site: 'serverAction.crew.settings.setLocale', orgId: crew.org_id })
    return { error: 'Could not save your language preference. Check your connection and try again.' }
  }
}
