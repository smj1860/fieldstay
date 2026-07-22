'use server'

import { revalidatePath }                from 'next/cache'
import { requireOrgMember }              from '@/lib/auth'
import { createServiceClient }           from '@/lib/supabase/server'
import { readIntegrationToken, disconnectIntegrationToken } from '@/lib/integrations/vault'
import { getProvider }                   from '@/lib/integrations/registry'
import { logAuditEvent }                 from '@/lib/audit'
// Hostaway is not fully implemented yet (see connectWithApiKey below) —
// storeIntegrationToken and hostawayExchangeCredentials are unused while
// it's disabled. Re-add both imports when re-enabling.
// import { storeIntegrationToken }       from '@/lib/integrations/vault'
// import { hostawayExchangeCredentials } from '@/lib/integrations/providers/hostaway'

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

/**
 * Manually re-fires a provider's sync from the Settings → Integrations card.
 * Looks up the connection by org_id (not the current session's user_id) since
 * the PM clicking resync may not be the PM who originally connected it.
 */
export async function triggerResync(
  providerId: string
): Promise<{ success?: boolean; error?: string }> {
  const { membership, user } = await requireOrgMember()

  if (!['owner', 'admin', 'manager'].includes(membership.role)) {
    return { error: 'Permission denied' }
  }

  const supabase = createServiceClient()
  const { data: connection } = await supabase
    .from('integration_connections')
    .select('user_id, org_id, external_user_id, status')
    .eq('org_id', membership.org_id)
    .eq('provider_id', providerId)
    .maybeSingle()

  if (!connection || connection.status === 'revoked' || connection.status === 'disconnected') {
    return { error: 'This integration isn’t connected — connect it first.' }
  }

  const { integrationResyncLimiter } = await import('@/lib/rate-limit')
  const { success: withinLimit } = await integrationResyncLimiter.limit(`${providerId}:${membership.org_id}`)
  if (!withinLimit) {
    return { error: 'Sync already in progress — please wait 60 seconds before trying again' }
  }

  const { inngest } = await import('@/lib/inngest/client')

  switch (providerId) {
    case 'hospitable': {
      const resolvedOrgId = connection.org_id ?? membership.org_id

      await inngest.send({
        name: 'integration/hospitable.connected',
        data: {
          user_id:          connection.user_id,
          org_id:            resolvedOrgId,
          external_user_id:  connection.external_user_id ?? '',
        },
      })

      // integration/hospitable.connected's initial sync doesn't touch
      // calendar blocks (that's the daily hospCalendarSyncCron's job) — fan
      // out a calendar re-check for every active Hospitable property too, so
      // "Trigger Resync" means everything resyncs, not "everything except
      // blocks, wait for tomorrow's cron."
      const { data: hospProperties } = await supabase
        .from('properties')
        .select('id, external_id')
        .eq('org_id', resolvedOrgId)
        .eq('external_source', 'hospitable')
        .eq('is_active', true)
        .not('external_id', 'is', null)

      if (hospProperties?.length) {
        await inngest.send(
          hospProperties.map((p) => ({
            name: 'integration/hospitable.calendar_sync.requested' as const,
            data: {
              property_id:            p.id,
              org_id:                 resolvedOrgId,
              user_id:                connection.user_id,
              hospitable_property_id: p.external_id!,
            },
          }))
        )
      }

      break
    }

    case 'ownerrez':
      await inngest.send({
        name: 'ownerrez/sync.now.requested',
        data: {
          org_id:  membership.org_id,
          user_id: connection.user_id,
          trigger: 'manual',
        },
      })
      break

    // Hostaway is not fully implemented yet — see connectWithApiKey below.
    // case 'hostaway':
    //   await inngest.send({
    //     name: 'integration/hostaway.sync.requested',
    //     data: {
    //       user_id:     connection.user_id,
    //       org_id:      connection.org_id ?? membership.org_id,
    //       provider_id: providerId,
    //       full_sync:   true,
    //     },
    //   })
    //   break

    case 'kroger':
      // Kroger has no property/booking sync — this re-runs the nearest-store
      // lookup that picks preferred_retailer, in case the org's properties
      // have changed since it last ran.
      await inngest.send({
        name: 'integration/kroger.connected',
        data: {
          org_id:  connection.org_id ?? membership.org_id,
          user_id: connection.user_id,
        },
      })
      break

    default:
      return { error: `Resync isn't supported for ${providerId} yet.` }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'integration.sync_triggered',
    targetType: 'integration',
    targetId:   providerId,
    metadata:   { provider_id: providerId, trigger: 'manual' },
  })

  revalidatePath('/settings/integrations')
  return { success: true }
}

export async function disconnectIntegration(
  providerId: string
): Promise<{ error?: string }> {
  const { membership, user: authUser } = await requireOrgMember()
  const user = authUser
  if (!user) return { error: 'Not authenticated' }

  try {
    // Resolve the connection's owner — the user who originally went through OAuth
    // may differ from the current user (e.g. an org admin disconnecting a connection
    // their colleague set up). Vault operations key on user_id, so we need the
    // actual owner, not the current session user. Mirrors triggerResync's approach.
    const supabase = createServiceClient()
    const { data: connection } = await supabase
      .from('integration_connections')
      .select('user_id')
      .eq('org_id', membership.org_id)
      .eq('provider_id', providerId)
      .maybeSingle()

    if (!connection) {
      return { error: 'This integration isn\'t connected.' }
    }

    const connectionUserId = connection.user_id

    // 1. Retrieve the token from Vault (keyed to the connection's owner)
    const accessToken = await readIntegrationToken(connectionUserId, providerId)

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

    // 3. Disconnect in Vault (marks connection 'disconnected' + deletes secret —
    //    distinct from revokeIntegrationToken, which is for involuntary revocation)
    await disconnectIntegrationToken(connectionUserId, providerId)

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
 *
 * Hostaway is not fully implemented yet — its sync never fires
 * booking/confirmed (see lib/inngest/functions/hostaway/initial-sync.ts and
 * ops/page.tsx's REVENUE_AUTOMATION_PROVIDER_IDS comment), so a connected
 * org would get properties/bookings synced in with no automatic revenue
 * posting. Disabled at every connect entry point (this action, the
 * settings/integrations UI, and setup/pms) until that lands — uncomment the
 * block below (and the storeIntegrationToken/hostawayExchangeCredentials
 * imports at the top of this file) to re-enable.
 */
export async function connectWithApiKey(
  providerId:  string,
  _credentials: Record<string, string>
): Promise<{ success?: boolean; error?: string; externalUserId?: string }> {
  await requireOrgMember()

  // const { user, membership } = await requireOrgMember()
  //
  // try {
  //   let accessToken:    string
  //   let expiresAt:      string
  //   let externalUserId: string
  //
  //   // ── Provider-specific credential exchange ──────────────────────────
  //   if (providerId === 'hostaway') {
  //     const { accountId, apiKey } = credentials
  //     if (!accountId?.trim() || !apiKey?.trim()) {
  //       return { error: 'Account ID and API Key are both required' }
  //     }
  //     const result = await hostawayExchangeCredentials(accountId.trim(), apiKey.trim())
  //     accessToken    = result.accessToken
  //     expiresAt      = result.expiresAt
  //     externalUserId = result.externalUserId
  //   } else {
  //     return { error: `Unsupported provider for credential-based connect: ${providerId}` }
  //   }
  //
  //   // ── Store token in Vault + upsert the connection row ────────────────
  //   await storeIntegrationToken({
  //     userId:         user.id,
  //     providerId,
  //     accessToken,
  //     externalUserId,
  //     metadata:       { last_sync_status: 'pending' },
  //   })
  //
  //   // Link to the org and record expiry — storeIntegrationToken doesn't
  //   // know about org_id or expires_at, so patch them in after.
  //   const admin = createServiceClient()
  //   // Scope to rows with no org_id yet (first connect — storeIntegrationToken
  //   // doesn't set org_id on insert) or already matching this org (reconnect).
  //   // Never let this silently repoint a connection that belongs to a
  //   // different org the user is also a member of.
  //   const { error: linkErr } = await admin
  //     .from('integration_connections')
  //     .update({ org_id: membership.org_id, expires_at: expiresAt })
  //     .eq('user_id', user.id)
  //     .eq('provider_id', providerId)
  //     .or(`org_id.is.null,org_id.eq.${membership.org_id}`)
  //
  //   if (linkErr) throw new Error(linkErr.message)
  //
  //   // ── Fire Inngest initial sync ──────────────────────────────────────
  //   const { inngest } = await import('@/lib/inngest/client')
  //   await inngest.send({
  //     name: 'integration/hostaway.sync.requested',
  //     data: {
  //       user_id:     user.id,
  //       org_id:      membership.org_id,
  //       provider_id: providerId,
  //       full_sync:   true,
  //     },
  //   })
  //
  //   revalidatePath('/settings/integrations')
  //   return { success: true, externalUserId }
  // } catch (err) {
  //   const msg = err instanceof Error ? err.message : 'Connection failed'
  //   // Don't expose provider error details to client — log server-side only
  //   console.error(`[connectWithApiKey:${providerId}]`, msg)
  //   if (msg.toLowerCase().includes('401') || msg.toLowerCase().includes('invalid')) {
  //     return { error: 'Invalid credentials — check your Account ID and API Key.' }
  //   }
  //   return { error: 'Connection failed. Please try again or contact support.' }
  // }

  return { error: `${providerId} isn't available to connect yet.` }
}
