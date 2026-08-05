import 'server-only'

import { createClient } from '@/lib/supabase/server'
import { reportQueryError } from '@/lib/supabase/unwrap'

// ============================================================================
// Ownership checks for a client-supplied record id.
//
// Deliberately NOT in lib/auth.ts, even though requireProperty (the redirecting
// Server-Component sibling of the check below) lives there. Every Server Action
// test mocks '@/lib/auth' wholesale to stub requireOrgMember, so a check placed
// there would be stubbed out too — and the tests that would silently stop
// testing anything are exactly the IDOR ones, which assert that another org's
// property_id is rejected. Keeping this outside that mock boundary means those
// tests keep exercising the real query.
// ============================================================================

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Server Action counterpart to requireProperty: proves a client-supplied
 * property_id belongs to the caller's org, and returns an error string instead
 * of redirecting (a Server Action has no page to redirect to).
 *
 * Extracted because this exact check was open-coded seven times across the
 * maintenance, turnovers and inventory action files — the same shape of drift
 * requireCrewMember and requirePlatformStaff exist to prevent, and the kind
 * that only stays correct while nobody edits one copy.
 *
 * Distinguishes the two outcomes those copies had already learned to separate:
 * a failed read is not "this property isn't yours". Callers that need to say
 * something specific about what was lost pass `unavailableMessage`.
 */
export interface VerifiedProperty {
  id:       string
  /** IANA identifier. Nullable in the schema; callers must pick a fallback. */
  timezone: string | null
}

export async function verifyPropertyInOrg(
  supabase:   SupabaseServerClient,
  orgId:      string,
  propertyId: string,
  site:       string,
  unavailableMessage = 'Could not verify the property. Please try again.',
): Promise<{ ok: true; property: VerifiedProperty } | { ok: false; error: string }> {
  // maybeSingle, so a property that genuinely is not in this org comes back as
  // data:null rather than a PGRST116 error, leaving `error` to mean only a
  // real failure.
  //
  // `timezone` rides along on a read that already had to happen. It is
  // returned rather than fetched separately because createManualTurnover
  // needed it and the alternative was either a second round trip or a local
  // re-implementation of "verified" — the drift this helper exists to stop.
  // Additive: the six callers that only branch on `ok` are unaffected.
  const res = await supabase
    .from('properties')
    .select('id, timezone')
    .eq('id', propertyId)
    .eq('org_id', orgId)
    .maybeSingle()

  if (reportQueryError(res.error, { site, orgId })) {
    return { ok: false, error: unavailableMessage }
  }
  if (!res.data) return { ok: false, error: 'Property not found' }

  return { ok: true, property: res.data }
}
