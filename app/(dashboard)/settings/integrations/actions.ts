'use server'

import { revalidatePath }           from 'next/cache'
import { requireOrgMember }         from '@/lib/auth'
import { createServiceClient }      from '@/lib/supabase/server'
import { getIntegrationToken, deleteIntegrationToken } from '@/lib/integrations/vault'
import { revokeToken }              from '@/lib/integrations/providers/ownerrez'

export async function disconnectIntegration(
  providerId: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()
  const { data: { user } }       = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  try {
    // 1. Retrieve the token from Vault
    const accessToken = await getIntegrationToken(user.id, providerId)

    // 2. Revoke at the provider (best-effort)
    if (accessToken) {
      try {
        await revokeToken(accessToken)
      } catch (err) {
        console.error(`[disconnect:${providerId}] Provider revocation failed:`, err instanceof Error ? err.message : err)
        // Non-fatal — continue with local cleanup
      }
    }

    // 3. Delete from Vault
    await deleteIntegrationToken(user.id, providerId)

    // 4. Delete the connection row
    const admin = createServiceClient()
    await admin
      .from('integration_connections')
      .delete()
      .eq('user_id', user.id)
      .eq('provider_id', providerId)

    revalidatePath('/settings/integrations')
    return {}

  } catch (err) {
    console.error(`[disconnect:${providerId}] Failed:`, err instanceof Error ? err.message : err)
    return { error: 'Failed to disconnect. Please try again.' }
  }
}
