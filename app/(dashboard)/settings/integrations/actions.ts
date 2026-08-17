'use server'

import { revalidatePath }                from 'next/cache'
import { requireOrgMember }              from '@/lib/auth'
import { createServiceClient }           from '@/lib/supabase/server'
import { readIntegrationToken, readIntegrationRefreshToken, disconnectIntegrationToken } from '@/lib/integrations/vault'
import { getProvider }                   from '@/lib/integrations/registry'
import { linkConnectionToOrg }           from '@/lib/integrations/finalize-connection'
import { logAuditEvent }                 from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { tryUnwrap, reportQueryError } from '@/lib/supabase/unwrap'
import { storeIntegrationToken }       from '@/lib/integrations/vault'
import { hostawayExchangeCredentials } from '@/lib/integrations/providers/hostaway'

export async function getSyncProgress(providerId: string): Promise<{
  propertiesFound: number | null
  bookingsFound:   number | null
  lastSyncStatus:  string | null
} | null> {
  try {
    // Scoped by org, not the current viewer's session — the PM watching
    // sync progress may not be the PM who originally connected the
    // integration (same pattern as triggerResync below).
    const { membership } = await requireOrgMember()
    const supabase = createServiceClient({ authorizedBy: membership })

    const res = await supabase
      .from('integration_connections')
      .select('metadata')
      .eq('org_id', membership.org_id)
      .eq('provider_id', providerId)
      .maybeSingle()

    // Degrading to null is right for this one — it drives a progress readout
    // that the client polls, so a blank tick is recoverable and throwing would
    // break the page. tryUnwrap keeps the degradation while still logging and
    // reporting, so a persistent outage shows up somewhere.
    const out = tryUnwrap(res, {
      site:  'serverAction.settings.integrations.getSyncProgress',
      orgId: membership.org_id,
    })
    if (!out.ok || !out.data) return null

    const meta = (out.data.metadata as Record<string, unknown> | null) ?? {}
    return {
      propertiesFound: typeof meta.properties_found === 'number' ? meta.properties_found : null,
      bookingsFound:   typeof meta.bookings_found   === 'number' ? meta.bookings_found   : null,
      lastSyncStatus:  typeof meta.last_sync_status === 'string' ? meta.last_sync_status : null,
    }
  } catch (err) {
    // Was a bare `catch { return null }` — every failure here, including a
    // thrown auth error, vanished with nothing logged anywhere. CLAUDE.md:
    // a caught error must do something visible.
    console.error('[getSyncProgress]', err)
    reportError(err, { site: 'serverAction.settings.integrations.getSyncProgress' })
    return null
  }
}

/**
 * Both credentials a provider might need to revoke, read from Vault.
 *
 * The refresh token comes along because some providers revoke the two
 * SEPARATELY — Hostex does, and revoking only the access token there leaves a
 * live refresh token able to mint new ones for an account the user has just
 * disconnected. A provider with none stored simply has none to revoke.
 *
 * Failing to READ the refresh token is never a reason to abandon a disconnect
 * the user asked for, so that read degrades to null. Extracted from
 * disconnectIntegration to keep it under the cognitive-complexity ceiling.
 */
async function readRevocableCredentials(
  connectionUserId: string,
  providerId:       string,
): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  const accessToken = await readIntegrationToken(connectionUserId, providerId)

  let refreshToken: string | null = null
  try {
    refreshToken = await readIntegrationRefreshToken(connectionUserId, providerId)
  } catch (err) {
    console.warn(`[disconnect:${providerId}] refresh-token read failed; revoking access token only`, err)
  }

  return { accessToken, refreshToken }
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

  const supabase = createServiceClient({ authorizedBy: membership })
  const connectionRes = await supabase
    .from('integration_connections')
    .select('user_id, org_id, external_user_id, status')
    .eq('org_id', membership.org_id)
    .eq('provider_id', providerId)
    .maybeSingle()

  // Same reasoning as disconnectIntegration below, milder consequence: a failed
  // read told a PM whose integration is connected and healthy that it isn't
  // connected at all, which is the message that sends them to reconnect (and
  // re-authorize with the provider) to fix a problem that was never theirs.
  const connectionOut = tryUnwrap(connectionRes, {
    site:  'serverAction.settings.integrations.triggerResync.lookup',
    orgId: membership.org_id,
  })

  if (!connectionOut.ok) {
    return { error: 'Couldn\'t check the integration right now. Please try again.' }
  }

  const connection = connectionOut.data
  if (!connection || connection.status === 'revoked' || connection.status === 'disconnected') {
    return { error: 'This integration isn’t connected — connect it first.' }
  }

  // onError: 'deny' — this limiter exists to stop a panicking PM from
  // hammering "Trigger Resync" and burning the provider's API quota, so it is
  // a quota ceiling, not an abuse throttle: a ceiling that disappears during a
  // Redis outage is not a ceiling (same fail-CLOSED stance as
  // claimNudgeBudgetSlot in CLAUDE.md). The cost of failing closed is one
  // manual resync deferred until Redis recovers.
  const { integrationResyncLimiter, checkLimit } = await import('@/lib/rate-limit')
  const resyncLimit = await checkLimit(
    integrationResyncLimiter,
    `${providerId}:${membership.org_id}`,
    { onError: 'deny', site: 'action.settings.integrations.triggerResync' },
  )
  if (!resyncLimit.allowed) {
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
      const { data: hospProperties, error: hospPropertiesError } = await supabase
        .from('properties')
        .select('id, external_id')
        .eq('org_id', resolvedOrgId)
        .eq('external_source', 'hospitable')
        .eq('is_active', true)
        .not('external_id', 'is', null)
        .limit(500)

      reportQueryError(hospPropertiesError, {
        site:  'serverAction.settings.integrations.triggerResync.hospProperties',
        orgId: resolvedOrgId,
      })

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

    case 'hostex':
      // integration/hostex.connected, not the daily reconcile event: a manual
      // resync should re-read PROPERTIES too (a renamed or newly-added
      // listing), and re-post revenue for every confirmed stay rather than
      // only new ones. hostexInitialSync is idempotent — properties upsert on
      // (org_id, external_id, external_source), bookings the same, and
      // handleBookingConfirmed dedups on source_reference_id — so "resync" is
      // genuinely re-runnable and is what REPAIRS an org whose first sync
      // failed partway.
      await inngest.send({
        name: 'integration/hostex.connected',
        data: {
          user_id:          connection.user_id,
          org_id:           connection.org_id ?? membership.org_id,
          external_user_id: connection.external_user_id ?? '',
        },
      })
      break

    case 'hostaway':
      // Re-reads listings as well as reservations, which the daily reconcile
      // deliberately does not — that is the difference between "resync" and
      // the nightly sweep.
      await inngest.send({
        name: 'integration/hostaway.sync.requested',
        data: {
          user_id:     connection.user_id,
          org_id:      connection.org_id ?? membership.org_id,
          provider_id: providerId,
          full_sync:   true,
        },
      })
      break

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

  // Gated tighter than triggerResync (owner/admin/manager) on purpose:
  // disconnecting revokes the provider token and deletes the Vault secret,
  // and the only way back is a fresh OAuth round trip by someone holding the
  // provider credentials. 'manager' is deliberately excluded.
  if (!['owner', 'admin'].includes(membership.role)) {
    return { error: 'Permission denied' }
  }

  try {
    // Resolve the connection's owner — the user who originally went through OAuth
    // may differ from the current user (e.g. an org admin disconnecting a connection
    // their colleague set up). Vault operations key on user_id, so we need the
    // actual owner, not the current session user. Mirrors triggerResync's approach.
    const supabase = createServiceClient({ authorizedBy: membership })
    const connectionRes = await supabase
      .from('integration_connections')
      .select('user_id')
      .eq('org_id', membership.org_id)
      .eq('provider_id', providerId)
      .maybeSingle()

    // Unwrapped because the two outcomes this read collapses have opposite
    // meanings for a credential. Discarded, a failed lookup produced the same
    // null as "no such connection", so the PM was told the integration isn't
    // connected and the action returned — while the provider token stayed live
    // in Vault and the connection stayed active. The PM believes they revoked
    // access; nothing revoked it, and nothing retries.
    //
    // This is the same defect, on the same table, that findUserByExternalId
    // carried in the provider revocation webhook (see the note where it was
    // deleted in lib/integrations/vault.ts).
    const connectionOut = tryUnwrap(connectionRes, {
      site:  'serverAction.settings.integrations.disconnectIntegration.lookup',
      orgId: membership.org_id,
    })

    if (!connectionOut.ok) {
      return { error: 'Couldn\'t reach the integration right now — nothing was disconnected. Please try again.' }
    }

    const connection = connectionOut.data
    if (!connection) {
      return { error: 'This integration isn\'t connected.' }
    }

    const connectionUserId = connection.user_id

    // 1. Retrieve the tokens from Vault (keyed to the connection's owner).
    const { accessToken, refreshToken } = await readRevocableCredentials(connectionUserId, providerId)

    // 2. Revoke at the provider (best-effort)
    if (accessToken) {
      try {
        const provider = getProvider(providerId)
        if (provider?.revokeAccessToken) {
          await provider.revokeAccessToken({
            token:        accessToken,
            refreshToken: refreshToken ?? undefined,
          })
        }
      } catch (err) {
        console.error(`[disconnect:${providerId}] Provider revocation failed:`, err instanceof Error ? err.message : err)
        reportError(err, { site: 'serverAction.settings.integrations.disconnectIntegration' })
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
    reportError(err, { site: 'serverAction.settings.integrations.disconnectIntegration' })
    return { error: 'Failed to disconnect. Please try again.' }
  }
}

/**
 * Credential-entry connect flow for API-key-based providers (Hostaway).
 *
 * Unlike the OAuth providers there is no browser redirect: the PM pastes an
 * Account ID and API Key, and this exchanges them for a Bearer token server-
 * side. Hostaway is the only provider on this path, so the finalize-connection
 * helper the OAuth callback uses does not fit — that helper starts from an
 * authorization code and a pending link row, neither of which exists here.
 *
 * The RAW API KEY IS NEVER STORED. hostawayExchangeCredentials trades it once
 * for a ~6-month Bearer token and only that token reaches the Vault, so a
 * database compromise cannot mint fresh tokens. The cost is that expiry needs a
 * human — see NON_REFRESHABLE_PROVIDERS in cron/integration-token-refresh.ts,
 * which emails the PM to reconnect rather than attempting a refresh that has
 * nothing to refresh from.
 */
export async function connectWithApiKey(
  providerId:  string,
  credentials: Record<string, string>
): Promise<{ success?: boolean; error?: string; externalUserId?: string }> {
  const { user, membership } = await requireOrgMember()

  // Allowlist, not a fallthrough. This action takes a provider id from the
  // client, and every id that reaches the exchange below must be one we
  // deliberately support on this path — an OAuth provider arriving here should
  // be refused, not handed PM-entered credentials.
  if (providerId !== 'hostaway') {
    return { error: `${providerId} isn't available to connect yet.` }
  }

  try {
    const accountId = credentials.accountId?.trim()
    const apiKey    = credentials.apiKey?.trim()
    if (!accountId || !apiKey) {
      return { error: 'Account ID and API Key are both required' }
    }

    const { accessToken, expiresAt, externalUserId } =
      await hostawayExchangeCredentials(accountId, apiKey)

    await storeIntegrationToken({
      userId:         user.id,
      providerId,
      accessToken,
      externalUserId,
      metadata:       { last_sync_status: 'pending' },
    })

    // Link to the org and record expiry — storeIntegrationToken knows about
    // neither. linkConnectionToOrg owns the tenant boundary (it can claim an
    // unowned or already-ours row and never one belonging to a different org
    // this user also belongs to), shared with the OAuth callback so the rule
    // lives in one place rather than being mirrored here by convention.
    const admin  = createServiceClient({ authorizedBy: membership })
    const linked = await linkConnectionToOrg({
      admin,
      userId:     user.id,
      providerId,
      orgId:      membership.org_id,
      expiresAt,
    })

    if (!linked) {
      // The row exists and belongs to another org this user is also a member
      // of. Do NOT fire a sync attributed to this org — it would look for a
      // token the connection does not hold.
      return { error: 'That Hostaway account is already connected to a different organization.' }
    }

    // provider_id only — never the Account ID, and obviously never the key.
    // Audit rows are meant to be readable by staff investigating an incident,
    // not a second home for a credential.
    await logAuditEvent({
      orgId:    membership.org_id,
      actorId:  user.id,
      action:   'integration.connected',
      metadata: { provider_id: providerId },
    })

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
    // Never surface the provider's error text: hostawayExchangeCredentials
    // includes the response body in its message, and that body is echoed
    // credentials often enough to matter.
    const msg = err instanceof Error ? err.message : 'Connection failed'
    reportError(err, { site: 'serverAction.settings.integrations.connectWithApiKey', orgId: membership.org_id })
    if (msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('invalid')) {
      return { error: 'Invalid credentials — check your Account ID and API Key.' }
    }
    return { error: 'Connection failed. Please try again or contact support.' }
  }
}
