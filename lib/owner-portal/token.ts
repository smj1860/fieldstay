import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { unwrap, unwrapList, type PostgrestResult } from '@/lib/supabase/unwrap'
import { unwrapJoin } from '@/lib/utils/supabase-joins'

// THE OWNER PORTAL'S ONLY AUTH, in one place.
//
// There is no signed-in user on any owner-facing surface. An opaque token in
// the URL is the entire boundary, and what it authorizes — an org, and a
// specific set of property ids — is the entire tenant isolation for everything
// downstream of it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A MODULE RATHER THAN A FUNCTION IN THE PAGE
//
// It lived inside app/owner/[token]/load-owner-portal-data.ts, which was
// correct while the page was the only thing that needed it. The report
// download is a second surface, and a second implementation of a tenant
// boundary is not a duplication problem — it is two places that have to be
// fixed when one of them turns out to be wrong, and no mechanism that notices
// when only one was.
//
// The revoked and expired checks are the concrete version of that. A PM who
// revokes a link expects it dead everywhere; a route that validated the token
// itself but forgot `revoked_at` would keep serving that owner's inspection
// reports after the portal page stopped rendering, and nothing would surface
// the discrepancy.

export type TokenRejection = 'not_found' | 'revoked' | 'expired'

export type PortalTokenResult =
  | { ok: false; reason: TokenRejection }
  | { ok: true;  token: PortalTokenRow }

export interface PortalOwnerProperty {
  id:      string
  name:    string
  address: string | null
  city:    string | null
  state:   string | null
  zip:     string | null
}

export interface PortalTokenRow {
  id:               string
  expires_at:       string | null
  revoked_at:       string | null
  last_accessed_at: string | null
  is_multi:         boolean | null
  property_ids:     string[] | null
  /** Supabase returns nested joins as object-or-array; unwrapJoin normalizes. */
  property_owners:  unknown
}

export const PORTAL_TOKEN_SELECT = `
  id,
  expires_at,
  revoked_at,
  last_accessed_at,
  is_multi,
  property_ids,
  property_owners (
    id,
    org_id,
    name,
    revenue_share_pct,
    share_capital_plan,
    property_id,
    properties (
      id,
      name,
      address,
      city,
      state,
      zip
    )
  )
`

/**
 * Resolves the opaque portal token.
 *
 * A FAILED READ THROWS rather than reporting "not found". The two are opposite
 * facts and collapsing them means a database outage renders as a revoked link —
 * a paying owner told their access was withdrawn, and a support conversation
 * that starts from the wrong premise.
 */
export async function validatePortalToken(
  supabase: SupabaseClient,
  token:    string,
): Promise<PortalTokenResult> {
  const res = await supabase
    .from('owner_portal_tokens')
    .select(PORTAL_TOKEN_SELECT)
    .eq('token', token)
    .maybeSingle()

  const row = unwrap(res as PostgrestResult<PortalTokenRow>, {
    site: 'owner-portal.validatePortalToken',
  })

  if (!row)            return { ok: false, reason: 'not_found' }
  if (row.revoked_at)  return { ok: false, reason: 'revoked' }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, token: row }
}

export interface PortalScope {
  orgId: string
  /** The owner's display name — never logged, never put in audit metadata. */
  ownerName: string
  /** EVERY property this token authorizes. The tenant boundary, token-derived. */
  propertyIds: string[]
  properties:  PortalOwnerProperty[]
}

/**
 * What the token authorizes, resolved from the token row alone.
 *
 * NOTHING HERE READS A REQUEST PARAMETER, and that is the point. The portal
 * page separately narrows this set with a `?property=` query value, which is
 * safe only because it can select among these ids and never widen them. A
 * caller that wants one property must intersect against `propertyIds` rather
 * than query for it — see `authorizesProperty`.
 *
 * Returns null when the token resolves to no property at all, which is a
 * malformed token rather than an empty portfolio.
 */
export async function resolvePortalScope(
  supabase: SupabaseClient,
  token:    PortalTokenRow,
): Promise<PortalScope | null> {
  const owner = unwrapJoin(token.property_owners) as {
    org_id: string
    name:   string | null
    properties: unknown
  } | null
  if (!owner?.org_id) return null

  const primary = unwrapJoin(owner.properties) as PortalOwnerProperty | null
  if (!primary?.id) return null

  const isMulti = !!token.is_multi
    && Array.isArray(token.property_ids)
    && token.property_ids.length > 1

  if (!isMulti) {
    return {
      orgId: owner.org_id,
      ownerName: owner.name ?? 'Owner',
      propertyIds: [primary.id],
      properties:  [primary],
    }
  }

  const res = await supabase
    .from('properties')
    .select('id, name, address, city, state, zip')
    .in('id', token.property_ids!)
    // Scoped to the TOKEN'S org as well as to its id list. The ids come from a
    // column, not a request, but an org filter costs nothing and means a stray
    // id written into property_ids cannot reach across tenants.
    .eq('org_id', owner.org_id)
    .order('name')
    .limit(token.property_ids!.length)

  const props = unwrapList<PortalOwnerProperty>(
    res as PostgrestResult<PortalOwnerProperty[]>,
    { site: 'owner-portal.portfolioProperties', orgId: owner.org_id },
  )

  const properties = props.length > 0 ? props : [primary]
  return {
    orgId: owner.org_id,
    ownerName: owner.name ?? 'Owner',
    propertyIds: properties.map((p) => p.id),
    properties,
  }
}

/**
 * Whether this token may see a specific property.
 *
 * The check a per-object download needs and org membership does not give it.
 * `requireOrgMember()`'s equivalent problem is named in CLAUDE.md's standing
 * checklist: proving the caller belongs to an org does not prove the object
 * they asked for by id is theirs. Here it is sharper — a multi-property token
 * legitimately spans several properties, so "this token is valid" and "this
 * token may have THAT inspection" are genuinely different questions.
 */
export function authorizesProperty(scope: PortalScope, propertyId: string): boolean {
  return scope.propertyIds.includes(propertyId)
}
