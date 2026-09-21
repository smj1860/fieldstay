// lib/integrations/providers/lodgify-webhook.ts
// ============================================================================
// Inbound-webhook registration for a Lodgify connection.
//
// ── WHY REGISTRATION IS OFF BY DEFAULT ──────────────────────────────────────
//
// `LODGIFY_WEBHOOKS_ENABLED` gates every call in this file, and it is unset
// (i.e. off) until a real Lodgify account has confirmed the items in
// docs/Integrations/lodgify/ENABLEMENT.md. Nothing about our own handling is
// unsafe with it off or on — the route authenticates the same way either way —
// but registration is the one operation here that WRITES to a prospect's
// Lodgify account, and the request body's field names ({ event, target_url })
// are documented rather than verified. A subscribe call that is wrong is a
// failed POST at worst and a subscription pointing somewhere unintended at
// best, on the account of the PM we are trying to win.
//
// With the flag off, a Lodgify org still syncs: lodgifyReservationReconcileCron
// sweeps daily, which is the same posture OwnerRez shipped with and better
// than Hostaway's current one. Turning the flag on upgrades latency from a day
// to seconds; it does not switch the integration on.
//
// ── WHY THE FILE EXISTS AT ALL, rather than living in the Inngest step ──────
//
// Inngest PERSISTS every step's return value in run history, so a step whose
// body handles a routing credential is one careless `return` away from writing
// it there — which is what unit/guardrails/inngest-history-secrets.test.ts
// scans for. Keeping the token inside a plain async function means the step
// returns a summary and nothing else. Same reasoning, same shape, as
// hostex-webhook.ts.
// ============================================================================

import 'server-only'

import { randomBytes } from 'node:crypto'

import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { lodgifyDeleteWebhooks, lodgifyEnsureWebhook } from '@/lib/integrations/providers/lodgify-api'
import { LODGIFY_BOOKING_EVENTS } from '@/lib/integrations/providers/lodgify.types'

const PROVIDER = 'lodgify'

export interface LodgifyWebhookRegistrationResult {
  /** false when nothing was attempted — flag off, or no app URL configured. */
  attempted: boolean
  /** How many of the booking events were newly subscribed on this run. */
  created:   number
  /** Why nothing was attempted, for the caller's log line. */
  reason?:   'disabled' | 'no_app_url'
}

/** The kill switch. Exported so the route and the docs can agree on one reading. */
export function lodgifyWebhooksEnabled(): boolean {
  // Exactly 'true', matching SMS_ENABLED's convention — a typo'd 'TRUE'
  // leaves registration OFF rather than silently enabling it, which is the
  // safe direction for a flag whose whole purpose is to withhold writes to
  // someone else's account.
  return process.env.LODGIFY_WEBHOOKS_ENABLED === 'true'
}

/**
 * The per-connection inbound URL, minting its token on first use.
 *
 * The token is generated ONCE and reused forever. Rotating it would orphan the
 * URL already registered with Lodgify and silently end delivery — a failure
 * that looks like "the provider stopped sending", which is close to
 * unfalsifiable from our side.
 *
 * 32 bytes from crypto, never Math.random: for Lodgify this token is not
 * merely a routing key, it is the ONLY credential on the inbound path. There
 * is no documented signature or shared secret to fall back on, so its entropy
 * is the entire authentication story — which is also why the route rate-limits
 * and why nothing in a delivery body is trusted.
 */
async function ensureWebhookToken(userId: string): Promise<string> {
  const admin = createServiceClient({ system: 'lib/integrations/providers/lodgify-webhook' })

  const existingRes = await admin
    .from('integration_connections')
    .select('webhook_token')
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  const existing = unwrap(existingRes, { site: 'lib.integrations.lodgify-webhook.read-token' })
  if (existing?.webhook_token) return existing.webhook_token

  const webhookToken = randomBytes(32).toString('hex')

  // ATOMIC CLAIM — `.is('webhook_token', null)` is load-bearing, not tidiness.
  //
  // Two callers can reach this concurrently for the same connection: initial
  // sync's register-webhook step and the daily reconcile's ensure-webhook step
  // (a manual resync during the reconcile's window is the everyday case).
  // Without the guard, both mint a DIFFERENT random token, both UPDATE
  // unconditionally, and each then registers ITS OWN token with Lodgify
  // regardless of which write won — so Lodgify pushes to two URLs while the DB
  // remembers one, and every delivery landing on the orphaned URL is rejected
  // by our route and lost. Whether Lodgify retries a rejected delivery is
  // unconfirmed, so those have to be assumed gone.
  //
  // Mirrors ensureHostexWebhookRegistration, which was fixed for exactly this.
  const claimRes = await admin
    .from('integration_connections')
    .update({ webhook_token: webhookToken, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
    .is('webhook_token', null)
    .select('webhook_token')
    .maybeSingle()

  if (claimRes.error) throw new Error(`[Lodgify] Failed to store webhook token: ${claimRes.error.message}`)

  if (claimRes.data?.webhook_token) return claimRes.data.webhook_token

  // Lost the race — re-read and use the WINNER's token, never our own.
  const recheckRes = await admin
    .from('integration_connections')
    .select('webhook_token')
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  const recheck = unwrap(recheckRes, { site: 'lib.integrations.lodgify-webhook.recheck-token' })

  return recheck?.webhook_token ?? webhookToken
}

/**
 * Make sure Lodgify is pushing this connection's booking events to us.
 *
 * Idempotent end to end: the token is only minted when absent, and
 * lodgifyEnsureWebhook skips the subscribe when the (event, url) pair is
 * already registered.
 *
 * Subscribes only the three BOOKING events. rate_change and
 * guest_message_received have no consumer here, and a subscription with no
 * consumer is a delivery we authenticate and drop.
 */
export async function ensureLodgifyWebhookRegistration(
  userId: string,
  apiKey: string,
): Promise<LodgifyWebhookRegistrationResult> {
  if (!lodgifyWebhooksEnabled()) return { attempted: false, created: 0, reason: 'disabled' }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { attempted: false, created: 0, reason: 'no_app_url' }

  const webhookToken = await ensureWebhookToken(userId)
  const targetUrl    = `${appUrl}/api/webhooks/lodgify/${webhookToken}`

  let created = 0

  for (const event of LODGIFY_BOOKING_EVENTS) {
    // Three fixed events, not per-tenant rows — bounded by a constant, so this
    // is not the fan-out shape unit/guardrails/n-plus-one-loops.test.ts hunts.
    const result = await lodgifyEnsureWebhook(apiKey, userId, event, targetUrl)
    if (result.created) created++
  }

  return { attempted: true, created }
}

/**
 * Remove this connection's subscriptions from Lodgify, on disconnect.
 *
 * Called via lodgifyProvider.cleanupBeforeRevoke, i.e. while the API key is
 * still in Vault — unsubscribing needs it, and the disconnect flow is about to
 * delete it.
 *
 * Runs even when LODGIFY_WEBHOOKS_ENABLED is off, deliberately: the flag
 * governs whether we CREATE subscriptions, and refusing to clean up because
 * the flag was turned off after they were created would strand exactly the
 * registrations someone turned it off to stop.
 *
 * Deliberately does NOT clear `webhook_token`. The column is the routing key,
 * and keeping it means a later reconnect re-registers the SAME URL rather than
 * minting a second one; a rotated token would leave whatever we failed to
 * delete pointing at an address that will never be valid again.
 *
 * Returns quietly when there is nothing to do — no token minted yet, or no app
 * URL configured. Both mean no registration of ours can exist.
 */
export async function removeLodgifyWebhookRegistration(
  userId: string,
  apiKey: string,
): Promise<{ deleted: number }> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { deleted: 0 }

  const admin = createServiceClient({ system: 'lib/integrations/providers/lodgify-webhook' })

  const existingRes = await admin
    .from('integration_connections')
    .select('webhook_token')
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  const webhookToken = unwrap(existingRes, {
    site: 'lib.integrations.lodgify-webhook.read-token-for-delete',
  })?.webhook_token

  if (!webhookToken) return { deleted: 0 }

  return lodgifyDeleteWebhooks(apiKey, userId, `${appUrl}/api/webhooks/lodgify/${webhookToken}`)
}
