// src/app/api/webhooks/[provider]/route.ts
// ============================================================
// Incoming webhook handler for all integration providers.
//
// What happens here:
//   1. Validate the webhook's authenticity (provider-specific)
//   2. Parse the payload
//   3. Handle the generic "authorization revoked" event universally
//   4. Delegate everything else to the provider adapter
//   5. Return 200 immediately — never make OwnerRez wait
//
// OwnerRez webhook format for revocation:
//   POST body: { "action": "application_authorization_revoked", "user_id": 347311458 }
//   Auth: HTTP Basic Auth with credentials you set in app registration
//
// This URL in your OwnerRez app settings should be:
//   https://fieldstay.app/api/webhooks/ownerrez
// ============================================================

import { NextResponse, type NextRequest }            from 'next/server'
import { getProvider }                               from '@/lib/integrations/registry'
import { revokeIntegrationToken, findUserByExternalId } from '@/lib/integrations/vault'
import { logAuditEvent }                             from '@/lib/audit'
import { createServiceClient }                       from '@/lib/supabase/server'
import { inngest }                                   from '@/lib/inngest/client'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const resolvedParams = await params
  const providerId = resolvedParams.provider.toLowerCase()

  // ── 1. Validate the provider exists ───────────────────────
  let providerAdapter
  try {
    providerAdapter = getProvider(providerId)
  } catch {
    // Return 404 but don't reveal internals
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // ── 2. Authenticate the webhook request ───────────────────
  //    We must clone the request before reading it, because the body
  //    stream can only be consumed once. We pass the clone to validateWebhook
  //    so we can still read the JSON body afterward.
  const clonedForValidation = request.clone()

  let isAuthentic: boolean
  try {
    isAuthentic = await providerAdapter.validateWebhook(clonedForValidation)
  } catch (err) {
    console.error(`[Webhook:${providerId}] Validation error:`, err)
    // Fail closed — if we can't validate, reject
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isAuthentic) {
    console.warn(
      `[Webhook:${providerId}] Rejected unauthenticated request from IP ` +
      `${request.headers.get('x-forwarded-for') ?? 'unknown'}`
    )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── 3. Parse the payload ───────────────────────────────────
  let payload: Record<string, unknown>
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Extract standardized fields.
  // OwnerRez revocation format: { "action": "application_authorization_revoked", "user_id": 12345 }
  const action         = String(payload.action ?? payload.event_type ?? '')
  const externalUserId = String(payload.user_id ?? payload.account_id ?? '')
  const correlationId  = payload.id ? String(payload.id) : crypto.randomUUID()

  const safeAction        = action.slice(0, 100)
  const safeCorrelationId = correlationId.slice(0, 100)

  console.log(`[Webhook:${providerId}] action="${safeAction}" correlationId=${safeCorrelationId}`)

  // ── 4. Handle generic "authorization revoked" universally ─
  //    This event means the user disconnected our app from within OwnerRez.
  //    We must destroy their stored token so future API calls don't fail silently.
  if (action === 'application_authorization_revoked') {
    try {
      if (!externalUserId) {
        console.error(`[Webhook:${providerId}] Revocation event missing user_id`)
      } else {
        const appUserId = await findUserByExternalId(providerId, externalUserId)

        if (appUserId) {
          const supabase = createServiceClient()
          const { data: existingConn } = await supabase
            .from('integration_connections')
            .select('status, org_id')
            .eq('provider_id', providerId)
            .eq('external_user_id', externalUserId)
            .maybeSingle()

          if (!existingConn || existingConn.status === 'revoked') {
            console.log(
              `[Webhook:${providerId}] Revocation already processed or connection ` +
              `not found for external user ${externalUserId} — skipping`
            )
            return NextResponse.json({ received: true }, { status: 200 })
          }

          await revokeIntegrationToken(appUserId, providerId)
          console.log(
            `[Webhook:${providerId}] Token revoked — FieldStay user ${appUserId} ` +
            `(external user ${externalUserId})`
          )
          await logAuditEvent({
            actorId:    appUserId,
            action:     'integration.revoked',
            targetType: 'integration_provider',
            targetId:   providerId,
            metadata:   { externalUserId, trigger: 'webhook' },
            correlationId,
          })

          // Notify the PM — reuses the same email + template already used for
          // proactive-refresh-triggered revocations (lib/inngest/functions/notify-integration-error.ts)
          if (existingConn.org_id) {
            await inngest.send({
              name: 'integration/connection.error',
              data: {
                user_id:     appUserId,
                org_id:      existingConn.org_id,
                provider_id: providerId,
                reason:      'This connection was disconnected from the provider\'s side (someone revoked FieldStay\'s access). Reconnect to resume syncing.',
              },
            })
          } else {
            console.warn(
              `[Webhook:${providerId}] Revoked connection has no org_id — cannot notify PM for user ${appUserId}`
            )
          }
        } else {
          console.warn(
            `[Webhook:${providerId}] Revocation for unknown external user ${externalUserId} — ` +
            `may have already been disconnected`
          )
        }
      }
    } catch (err) {
      // Log but don't return 500 — OwnerRez must get a 200 or it will retry infinitely
      console.error(`[Webhook:${providerId}] Failed to process revocation:`, err)
    }

    // Return 200 immediately after revocation
    return NextResponse.json({ received: true }, { status: 200 })
  }

  // ── 5a. Dedup webhooks using the provider's own correlation id ──────────
  //    Most providers retry failed webhooks several times (exponential backoff).
  //    A successful DB write that times out before the response window
  //    generates retries — all of which we must discard after the first success.
  //    Keyed by `${providerId}:${payload.id}` so two providers can never collide
  //    on the same raw webhook id.
  //    payload.id (not the synthesized crypto.randomUUID() fallback in
  //    correlationId above) is required — without a real id from the
  //    provider there's nothing stable to dedup against.
  const webhookId = payload.id !== null ? String(payload.id) : null

  if (webhookId) {
    const admin = createServiceClient()

    const { error: dedupErr } = await admin
      .from('processed_webhooks')
      .insert({ webhook_id: `${providerId}:${webhookId}` })

    if (dedupErr) {
      if (dedupErr.code === '23505') {
        // Unique constraint violation — already processed; discard the retry
        return NextResponse.json({ received: true, duplicate: true }, { status: 200 })
      }
      // Non-fatal dedup failure — log and continue to avoid losing the event
      console.error(`[Webhook:${providerId}] Dedup insert failed: ${dedupErr.message}`)
    }
  }

  // Periodic TTL cleanup — fire-and-forget, runs on ~5% of ALL provider webhook
  // requests to amortise cleanup cost without a dedicated cron job.
  if (Math.random() < 0.05) {
    void (async () => {
      const { error } = await createServiceClient().rpc('cleanup_webhook_dedup')
      if (error) {
        console.warn(`[Webhook:${providerId}] TTL cleanup failed (non-fatal): ${error.message}`)
      }
    })()
  }

  // ── 5. Delegate provider-specific events ──────────────────
  //    Future events: booking.created, booking.modified, guest.updated, etc.
  //    These are fired via individual webhook subscriptions (POST /v2/webhooksubscriptions)
  //    and have a different payload format than the global revocation event.
  //
  //    We always return 200 quickly and offload heavy processing to Inngest.
  try {
    await providerAdapter.handleWebhookEvent({ action, payload, externalUserId, correlationId })
  } catch (err) {
    // Again: log, don't 500 — provider is not responsible for our processing errors
    console.error(`[Webhook:${providerId}] Handler threw for action "${action}":`, err)
  }

  return NextResponse.json({ received: true }, { status: 200 })
}
