// lib/integrations/providers/hospitable-owner.ts
// ============================================================================
// Resolves WHICH FieldStay org owns a Hospitable entity referenced by a webhook.
//
// Hospitable webhooks are registered globally in the partner portal, so the
// owning org can't be assumed from "the one active connection" the moment a
// second customer connects. This module is the single source of truth for
// that resolution. Every branch of hospIncrementalSync must go through
// resolveHospitableOwner() — never pick a connection directly.
//
// Resolution order (cheapest/most-certain first):
//   0. webhook payload's own data.user.id, matched against              — 0 API calls
//      integration_connections.external_user_id (same value, captured
//      at OAuth-connect time — see hospitable.ts's exchangeCodeForToken)
//   1. integration_entity_owners cache                                   — 0 API calls
//   2. local domain table, intersected with                              — 0 API calls
//      orgs holding an ACTIVE hospitable connection
//   3. token probe across active connections                             — <= N API calls, memoized
//
// Step 0 only fires when the caller passes externalUserId (not every webhook
// payload shape is confirmed to carry data.user.id — see the message.created
// case in hospitable.ts) and only trusts a match against a currently ACTIVE
// connection; anything else falls through to steps 1-3 rather than
// short-circuiting to null.
//
// SECURITY: an unresolvable entity returns null. It must NEVER fall back to
// "any active connection" — that is the cross-tenant misattribution this module
// exists to eliminate.
// ============================================================================

import { createServiceClient }     from '@/lib/supabase/server'
import { getValidHospitableToken } from './hospitable-token'
import { hospitableFetch }         from './hospitable'

const PROVIDER            = 'hospitable'
const HOSPITABLE_API_BASE = 'https://public.api.hospitable.com/v2'

export type HospitableEntityKind = 'reservation' | 'property' | 'review'

export interface ResolvedHospitableOwner {
  orgId:  string
  userId: string
  token:  string
}

/** Domain table + column that stores each entity kind's provider-side id. */
const LOCAL_SOURCE: Record<HospitableEntityKind, { table: string }> = {
  reservation: { table: 'bookings' },
  property:    { table: 'properties' },
  review:      { table: 'reviews' },
}

/** Single-entity GET used to prove ownership. 200 = this account owns it. */
function probeUrl(kind: HospitableEntityKind, externalId: string): string {
  switch (kind) {
    case 'reservation': return `${HOSPITABLE_API_BASE}/reservations/${externalId}`
    case 'property':    return `${HOSPITABLE_API_BASE}/properties/${externalId}`
    case 'review':      return `${HOSPITABLE_API_BASE}/reviews/${externalId}`
  }
}

interface ActiveConnection {
  user_id:          string
  org_id:           string
  external_user_id: string | null
}

type Supabase = ReturnType<typeof createServiceClient>

async function listActiveConnections(supabase: Supabase): Promise<ActiveConnection[]> {
  const { data, error } = await supabase
    .from('integration_connections')
    .select('user_id, org_id, external_user_id, updated_at')
    .eq('provider_id', PROVIDER)
    .eq('status',      'active')
    .not('org_id', 'is', null)
    .order('updated_at', { ascending: false })

  if (error) throw new Error(`listActiveConnections failed: ${error.message}`)

  return (data ?? []).map((row) => ({
    user_id:          row.user_id as string,
    org_id:           row.org_id  as string,
    external_user_id: (row.external_user_id as string | null) ?? null,
  }))
}

async function rememberOwner(
  supabase:    Supabase,
  kind:        HospitableEntityKind,
  externalId:  string,
  orgId:       string,
  resolvedVia: 'webhook_user_id' | 'local' | 'probe',
): Promise<void> {
  const { error } = await supabase
    .from('integration_entity_owners')
    .upsert(
      {
        provider_id:  PROVIDER,
        entity_kind:  kind,
        external_id:  externalId,
        org_id:       orgId,
        resolved_via: resolvedVia,
        updated_at:   new Date().toISOString(),
      },
      { onConflict: 'provider_id,entity_kind,external_id' },
    )

  // Non-fatal: a cache-write failure only costs a repeated probe next time.
  if (error) {
    console.warn(`[HospitableOwner] cache write failed (non-fatal): ${error.message}`)
  }
}

/**
 * Proves ownership by probing each candidate connection's token against the
 * entity's single-GET endpoint — 200 means that account owns it. Extracted
 * from resolveHospitableOwner() to keep its own cognitive complexity down;
 * candidate order is the caller's job (most-likely-owner first).
 *
 * @throws RateLimitError  propagated so the caller can step.sleep and retry.
 */
async function probeConnections(
  entityKind: HospitableEntityKind,
  externalId: string,
  candidates: ActiveConnection[],
): Promise<{ conn: ActiveConnection; token: string } | null> {
  for (const conn of candidates) {
    let token: string
    try {
      token = await getValidHospitableToken(conn.user_id)
    } catch {
      // This connection's token is unusable (revoked mid-flight, Vault miss).
      // Skip it — do not fail the whole resolution over one bad connection.
      continue
    }

    const res = await hospitableFetch(probeUrl(entityKind, externalId), token)

    if (res.status === 404 || res.status === 403) continue

    if (!res.ok) {
      throw new Error(
        `Hospitable ownership probe for ${entityKind} ${externalId} returned HTTP ${res.status}`,
      )
    }

    return { conn, token }
  }

  return null
}

/**
 * Resolves the org, connection user, and a valid access token for a Hospitable
 * entity. Returns null when no connected account owns it (disconnected org,
 * entity belongs to a non-customer, or entity was deleted provider-side).
 *
 * @throws RateLimitError  propagated so the caller can step.sleep and retry.
 * @throws Error           on unexpected provider/database failure — the caller
 *                         MUST let Inngest retry rather than guessing an org.
 */
export async function resolveHospitableOwner(params: {
  entityKind:      HospitableEntityKind
  externalId:      string
  externalUserId?: string
}): Promise<ResolvedHospitableOwner | null> {
  const { entityKind, externalId, externalUserId } = params
  const supabase = createServiceClient({ system: 'lib/integrations/providers/hospitable-owner' })

  const connections = await listActiveConnections(supabase)
  if (!connections.length) return null

  const byOrg = new Map(connections.map((c) => [c.org_id, c]))

  const finish = async (conn: ActiveConnection): Promise<ResolvedHospitableOwner> => ({
    orgId:  conn.org_id,
    userId: conn.user_id,
    token:  await getValidHospitableToken(conn.user_id),
  })

  // ── 0. Direct attribution from the webhook payload's own user id ───────────
  //     Deterministic and free (no extra query — external_user_id is already
  //     in the connections list fetched above). A present-but-unmatched id
  //     (connection since disconnected, or a stale/foreign value) falls
  //     through to the cache/local/probe chain rather than returning null.
  if (externalUserId) {
    const directMatch = connections.find((c) => c.external_user_id === externalUserId)
    if (directMatch) {
      await rememberOwner(supabase, entityKind, externalId, directMatch.org_id, 'webhook_user_id')
      return finish(directMatch)
    }
  }

  // ── 1. Cache ──────────────────────────────────────────────────────────────
  const { data: cached } = await supabase
    .from('integration_entity_owners')
    .select('org_id')
    .eq('provider_id', PROVIDER)
    .eq('entity_kind', entityKind)
    .eq('external_id', externalId)
    .maybeSingle()

  if (cached?.org_id) {
    const conn = byOrg.get(cached.org_id as string)
    if (conn) return finish(conn)
    // Cached org no longer has an active connection — fall through and re-resolve.
  }

  // ── 2. Local domain table ────────────────────────────────────────────────
  //     Selects ALL matches, not maybeSingle: (org_id, external_id,
  //     external_source) is the unique key, so a CO-HOSTED Hospitable property
  //     legitimately produces one row per org. maybeSingle() would throw here.
  const { data: localRows, error: localErr } = await supabase
    .from(LOCAL_SOURCE[entityKind].table)
    .select('org_id')
    .eq('external_id',     externalId)
    .eq('external_source', PROVIDER)

  if (localErr) throw new Error(`local owner lookup failed: ${localErr.message}`)

  const localOrgIds = [...new Set((localRows ?? []).map((r) => r.org_id as string))]
    .filter((orgId) => byOrg.has(orgId))

  if (localOrgIds.length === 1) {
    const conn = byOrg.get(localOrgIds[0]!)!
    await rememberOwner(supabase, entityKind, externalId, conn.org_id, 'local')
    return finish(conn)
  }

  // Zero matches (new entity) or >1 (co-hosted across two customers) both fall
  // through to the probe, which is authoritative either way.

  // ── 3. Token probe ───────────────────────────────────────────────────────
  //     Candidate order: any org that already has a local row goes first (most
  //     likely owner, fewest calls), then the rest by recency. RateLimitError
  //     from probeConnections() bubbles up uncaught — the caller sleeps and
  //     retries rather than this permanently dropping a real webhook.
  const ordered = [
    ...localOrgIds.map((orgId) => byOrg.get(orgId)!),
    ...connections.filter((c) => !localOrgIds.includes(c.org_id)),
  ]

  const probed = await probeConnections(entityKind, externalId, ordered)
  if (!probed) return null

  await rememberOwner(supabase, entityKind, externalId, probed.conn.org_id, 'probe')
  return { orgId: probed.conn.org_id, userId: probed.conn.user_id, token: probed.token }
}
