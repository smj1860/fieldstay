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

/**
 * Merges `patch` into integration_connections.metadata for the given
 * (userId, providerId) connection inside a single DB statement, optionally
 * also setting `status` in the same write. Returns the merged metadata.
 */
export async function mergeIntegrationConnectionMetadata(params: {
  userId:     string
  providerId: string
  patch:      Record<string, unknown>
  status?:    string
}): Promise<Record<string, unknown>> {
  const supabase = createServiceClient()

  const { data, error } = await supabase.rpc('merge_integration_connection_metadata', {
    p_user_id:     params.userId,
    p_provider_id: params.providerId,
    p_patch:       params.patch,
    p_status:      params.status ?? null,
  })

  if (error) {
    throw new Error(
      `[IntegrationConnection] Failed to merge metadata for provider "${params.providerId}": ${error.message}`
    )
  }

  return (data as Record<string, unknown> | null) ?? {}
}
