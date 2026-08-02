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
