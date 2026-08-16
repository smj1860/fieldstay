// lib/integrations/providers/hostex-webhook.ts
// ============================================================================
// Inbound-webhook registration for a Hostex connection.
//
// Kept out of the Inngest step that calls it, deliberately. Inngest PERSISTS
// every step's return value in run history, so a step whose body handles a
// routing credential is one careless `return` away from writing it there —
// which is what unit/guardrails/inngest-history-secrets.test.ts scans for, and
// it flagged this code when it lived inline. Keeping the credential inside a
// plain async function means the step returns a summary and nothing else.
// ============================================================================

import 'server-only'

import { randomBytes } from 'node:crypto'

import { createServiceClient } from '@/lib/supabase/server'
import { unwrap } from '@/lib/supabase/unwrap'
import { hostexEnsureWebhook } from '@/lib/integrations/providers/hostex-api'

const PROVIDER = 'hostex'

export interface WebhookRegistrationResult {
  /** false when nothing was done — no app URL configured. */
  attempted: boolean
  /** true only when a NEW registration was created on Hostex's side. */
  created:   boolean
}

/**
 * Make sure Hostex is pushing this connection's reservation events to us.
 *
 * The per-connection URL token is generated once and REUSED on every later
 * sync. Rotating it would orphan the URL already registered with Hostex and
 * silently end delivery — the failure would look like "the provider stopped
 * sending", which is close to unfalsifiable from our side.
 *
 * Idempotent end to end: the token is only minted when absent, and
 * hostexEnsureWebhook skips the POST when the URL is already registered.
 */
export async function ensureHostexWebhookRegistration(
  userId:      string,
  accessToken: string,
): Promise<WebhookRegistrationResult> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { attempted: false, created: false }

  const admin = createServiceClient({ system: 'lib/integrations/providers/hostex-webhook' })

  const existingRes = await admin
    .from('integration_connections')
    .select('webhook_token')
    .eq('user_id', userId)
    .eq('provider_id', PROVIDER)
    .maybeSingle()

  const existing = unwrap(existingRes, { site: 'lib.integrations.hostex-webhook.read-token' })

  let webhookToken = existing?.webhook_token ?? null

  if (!webhookToken) {
    // 32 bytes from crypto, never Math.random: this token is the sole routing
    // key AND the tenant boundary for an unauthenticated inbound request.
    webhookToken = randomBytes(32).toString('hex')

    const { error } = await admin
      .from('integration_connections')
      .update({ webhook_token: webhookToken, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('provider_id', PROVIDER)

    if (error) throw new Error(`[Hostex] Failed to store webhook token: ${error.message}`)
  }

  const { created } = await hostexEnsureWebhook(
    accessToken,
    userId,
    `${appUrl}/api/webhooks/hostex/${webhookToken}`,
  )

  return { attempted: true, created }
}
