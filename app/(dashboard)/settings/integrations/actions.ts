'use server'

import { revalidatePath }                from 'next/cache'
import { requireOrgMember }              from '@/lib/auth'
import { createServiceClient }           from '@/lib/supabase/server'
import { readIntegrationToken, revokeIntegrationToken, storeIntegrationToken } from '@/lib/integrations/vault'
import { getProvider }                   from '@/lib/integrations/registry'
import { logAuditEvent }                 from '@/lib/audit'
import { hostawayExchangeCredentials }   from '@/lib/integrations/providers/hostaway'

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

/**
 * Credential-entry connect flow for API-key-based providers (e.g. Hostaway).
 * Unlike OAuth providers, this exchanges PM-entered credentials for a token
 * directly from a server action — no browser redirect involved.
 */
export async function connectWithApiKey(
  providerId:  string,
  credentials: Record<string, string>
): Promise<{ success?: boolean; error?: string; externalUserId?: string }> {
  const { user, membership } = await requireOrgMember()

  try {
    let accessToken:    string
    let expiresAt:      string
    let externalUserId: string

    // ── Provider-specific credential exchange ──────────────────────────
    if (providerId === 'hostaway') {
      const { accountId, apiKey } = credentials
      if (!accountId?.trim() || !apiKey?.trim()) {
        return { error: 'Account ID and API Key are both required' }
      }
      const result = await hostawayExchangeCredentials(accountId.trim(), apiKey.trim())
      accessToken    = result.accessToken
      expiresAt      = result.expiresAt
      externalUserId = result.externalUserId
    } else {
      return { error: `Unsupported provider for credential-based connect: ${providerId}` }
    }

    // ── Store token in Vault + upsert the connection row ────────────────
    await storeIntegrationToken({
      userId:         user.id,
      providerId,
      accessToken,
      externalUserId,
      metadata:       { last_sync_status: 'pending' },
    })

    // Link to the org and record expiry — storeIntegrationToken doesn't
    // know about org_id or expires_at, so patch them in after.
    const admin = createServiceClient()
    // Scope to rows with no org_id yet (first connect — storeIntegrationToken
    // doesn't set org_id on insert) or already matching this org (reconnect).
    // Never let this silently repoint a connection that belongs to a
    // different org the user is also a member of.
    const { error: linkErr } = await admin
      .from('integration_connections')
      .update({ org_id: membership.org_id, expires_at: expiresAt })
      .eq('user_id', user.id)
      .eq('provider_id', providerId)
      .or(`org_id.is.null,org_id.eq.${membership.org_id}`)

    if (linkErr) throw new Error(linkErr.message)

    // ── Fire Inngest initial sync ──────────────────────────────────────
    const { inngest } = await import('@/lib/inngest/client')
    await inngest.send({
      name: 'integration/hostaway.sync.requested',
      data: {
        user_id:     user.id,
        org_id:      membership.org_id,
        provider_id: providerId,
        full_sync:   true,
      },
    })

    revalidatePath('/settings/integrations')
    return { success: true, externalUserId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection failed'
    // Don't expose provider error details to client — log server-side only
    console.error(`[connectWithApiKey:${providerId}]`, msg)
    if (msg.toLowerCase().includes('401') || msg.toLowerCase().includes('invalid')) {
      return { error: 'Invalid credentials — check your Account ID and API Key.' }
    }
    return { error: 'Connection failed. Please try again or contact support.' }
  }
}
