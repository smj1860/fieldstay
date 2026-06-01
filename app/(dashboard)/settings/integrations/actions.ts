'use server'

import { revalidatePath }                from 'next/cache'
import { requireOrgMember }              from '@/lib/auth'
import { createServiceClient }           from '@/lib/supabase/server'
import { readIntegrationToken, revokeIntegrationToken } from '@/lib/integrations/vault'
import { getProvider }                   from '@/lib/integrations/registry'

export async function disconnectIntegration(
  providerId: string
): Promise<{ error?: string }> {
  const { supabase } = await requireOrgMember()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  try {
    // 1. Retrieve the token from Vault
    const accessToken = await readIntegrationToken(user.id, providerId)

    // 2. Revoke at the provider (best-effort)
    if (accessToken) {
      try {
        const provider = getProvider(providerId)
        if (provider?.revokeAccessToken) {
          await provider.revokeAccessToken({ token: accessToken })
        }
      } catch (err) {
        console.error(`[disconnect:${providerId}] Provider revocation failed:`, err instanceof Error ? err.message : err)
        // Non-fatal — continue with local cleanup
      }
    }

    // 3. Revoke in Vault (marks connection revoked + deletes secret)
    await revokeIntegrationToken(user.id, providerId)

    revalidatePath('/settings/integrations')
    return {}

  } catch (err) {
    console.error(`[disconnect:${providerId}] Failed:`, err instanceof Error ? err.message : err)
    return { error: 'Failed to disconnect. Please try again.' }
  }
}
