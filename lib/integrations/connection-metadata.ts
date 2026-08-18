// lib/integrations/connection-metadata.ts
// ============================================================
// Atomic JSONB merge helper for integration_connections.metadata. See
// supabase/migrations/20260722130000_atomic_integration_connection_metadata_merge.sql
// for why a plain read-then-update in application code isn't safe here:
// concurrent sync runs for the same connection (e.g. a re-triggered
// OwnerRez initial sync racing an in-flight incremental sync tick) can
// otherwise silently clobber each other's metadata writes.
// ============================================================

import { createServiceClient } from '@/lib/supabase/server'
import type { Json } from '@/types/database'

/**
 * Merges `patch` into integration_connections.metadata for the given
 * (userId, providerId) connection inside a single DB statement, optionally
 * also setting `status` in the same write. Returns the merged metadata.
 */
export async function mergeIntegrationConnectionMetadata(params: {
  userId:     string
  providerId: string
  patch:      Record<string, Json>
  status?:    string
}): Promise<Record<string, Json | undefined>> {
  const supabase = createServiceClient({ system: 'lib/integrations/connection-metadata' })

  // p_status is DEFAULT NULL and the function does COALESCE(p_status, status),
  // so omitting it is exactly "leave status alone" — which is what the
  // generated `p_status?: string` signature expects. Passing an explicit null
  // means the same thing to Postgres but is not what the arg type allows.
  const { data, error } = await supabase.rpc('merge_integration_connection_metadata', {
    p_user_id:     params.userId,
    p_provider_id: params.providerId,
    p_patch:       params.patch,
    ...(params.status === undefined ? {} : { p_status: params.status }),
  })

  if (error) {
    throw new Error(
      `[IntegrationConnection] Failed to merge metadata for provider "${params.providerId}": ${error.message}`
    )
  }

  // The column is jsonb, so the RPC's return is only an object by convention.
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

/**
 * The connection statuses a sync may still run against.
 *
 * `error` IS included, and that is the entire point. It used to be excluded
 * everywhere — every OwnerRez read path filtered `.eq('status', 'active')` —
 * while the failure handler set `status: 'error'` and NOTHING anywhere ever set
 * it back. One transient blip (a 500, a timeout, a rate-limit) therefore
 * removed a tenant from every sync path permanently, and the PM-facing message
 * said "Sync failed — will retry automatically". It never did. Three
 * connections sat dead for three weeks that way before anyone looked
 * (2026-08-18).
 *
 * `revoked` stays excluded because it is genuinely terminal: the token is gone,
 * and only a reconnect can produce a new one. That distinction — transient vs.
 * terminal — is what the status column is FOR, and collapsing the two is what
 * made a retryable state unrecoverable.
 *
 * Use this everywhere a sync selects connections. A bare `.eq('status',
 * 'active')` in a sync path is the bug.
 */
export const SYNCABLE_CONNECTION_STATUSES = ['active', 'error'] as const
