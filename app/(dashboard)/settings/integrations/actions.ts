'use server'

import { revalidatePath }                from 'next/cache'
import { requireOrgMember }              from '@/lib/auth'
import { createServiceClient }           from '@/lib/supabase/server'
import { readIntegrationToken, revokeIntegrationToken } from '@/lib/integrations/vault'
import { getProvider }                   from '@/lib/integrations/registry'
import { logAuditEvent }                 from '@/lib/audit'

export async function getSyncProgress(providerId: string): Promise<{
  propertiesFound: number | null
  bookingsFound:   number | null
  lastSyncStatus:  string | null
} | null> {
  try {
    const { user } = await requireOrgMember()
    const supabase = createServiceClient()

    const { data } = await supabase
      .from('integration_connections')
      .select('metadata')
      .eq('user_id', user.id)
      .eq('provider_id', providerId)
      .maybeSingle()

    if (!data) return null

    const meta = (data.metadata as Record<string, unknown> | null) ?? {}
    return {
      propertiesFound: typeof meta.properties_found === 'number' ? meta.properties_found : null,
      bookingsFound:   typeof meta.bookings_found   === 'number' ? meta.bookings_found   : null,
      lastSyncStatus:  typeof meta.last_sync_status === 'string' ? meta.last_sync_status : null,
    }
  } catch {
    return null
  }
}

export async function disconnectIntegration(
  providerId: string
): Promise<{ error?: string }> {
  const { supabase, membership, user: authUser } = await requireOrgMember()
  const user = authUser
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

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'integration.disconnected',
      targetType: 'integration',
      targetId:   providerId,
    })

    revalidatePath('/settings/integrations')
    revalidatePath('/settings')
    revalidatePath('/ops')
    revalidatePath('/setup/power-ups')
    revalidatePath('/inventory')
    return {}

  } catch (err) {
    console.error(`[disconnect:${providerId}] Failed:`, err instanceof Error ? err.message : err)
    return { error: 'Failed to disconnect. Please try again.' }
  }
}
