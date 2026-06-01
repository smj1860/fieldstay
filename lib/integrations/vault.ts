'use server'

/**
 * Application-layer wrappers around the three Vault RPC functions.
 * All calls use the service-role client — never call vault.secrets directly.
 */

import { createServiceClient } from '@/lib/supabase/server'

export async function storeIntegrationToken(
  userId: string,
  providerId: string,
  accessToken: string,
  externalUserId: string,
  scope: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase.rpc('vault_store_integration_token', {
    user_id:          userId,
    provider_id:      providerId,
    access_token:     accessToken,
    external_user_id: externalUserId,
    scope,
    metadata,
  })
  if (error) throw new Error(`[vault] store failed: ${error.message}`)
}

export async function getIntegrationToken(
  userId: string,
  providerId: string
): Promise<string | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('vault_get_integration_token', {
    user_id:     userId,
    provider_id: providerId,
  })
  if (error) throw new Error(`[vault] get failed: ${error.message}`)
  return (data as string | null) ?? null
}

export async function deleteIntegrationToken(
  userId: string,
  providerId: string
): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase.rpc('vault_delete_integration_token', {
    user_id:     userId,
    provider_id: providerId,
  })
  if (error) throw new Error(`[vault] delete failed: ${error.message}`)
}
