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
import { createHash }                                from 'crypto'
import { getProvider }                               from '@/lib/integrations/registry'
import { revokeIntegrationToken, findUserByExternalId } from '@/lib/integrations/vault'
import { logAuditEvent }                             from '@/lib/audit'
import { createServiceClient }                       from '@/lib/supabase/server'
import { inngest }                                   from '@/lib/inngest/client'
import { reportError }                               from '@/lib/observability/report-error'
import type { WebhookVerificationResult }            from '@/lib/integrations/webhook-verification'

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

  let verification: WebhookVerificationResult
  try {
    verification = await providerAdapter.validateWebhook(clonedForValidation)
  } catch (err) {
    console.error(`[Webhook:${providerId}] Validation error:`, err)
    reportError(err, { site: 'webhook.provider.validate', extra: { provider: providerId } })
    // Fail closed — if we can't validate, reject
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!verification.valid) {
    console.warn(
      `[Webhook:${providerId}] Rejected request from IP ` +
      `${request.headers.get('x-forwarded-for') ?? 'unknown'}: ${verification.reason ?? 'no reason given'}`
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
  //    This event means the user disconnected our app from within the provider.
  //    We must destroy their stored token so future API calls don't fail silently.
  //
  //    Hospitable uses 'application_authorization_revoked', 'integration.disconnected',
  //    and 'integration_disconnected' interchangeably for this action — all three
  //    must trigger the same cleanup. OwnerRez uses only 'application_authorization_revoked'.
  const REVOCATION_ACTIONS = new Set([
    'application_authorization_revoked',
    'integration.disconnected',
    'integration_disconnected',
  ])

  if (REVOCATION_ACTIONS.has(action)) {
    try {
      if (!externalUserId) {
        console.error(`[Webhook:${providerId}] Revocation event missing user_id`)
        reportError(new Error('Revocation webhook missing user_id'), { site: 'webhook.provider.revocation_missing_user_id', extra: { provider: providerId } })
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

          if (!existingConn || existingConn.status === 'revoked' || existingConn.status === 'disconnected') {
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
            orgId:      existingConn.org_id ?? undefined,
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
            reportError(new Error('Revoked integration connection has no org_id'), {
              site:  'webhook.provider.revocation_missing_org_id',
              extra: { provider: providerId, app_user_id: appUserId },
            })
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
      reportError(err, { site: 'webhook.provider.revocation_processing', extra: { provider: providerId } })
    }

    // Return 200 immediately after revocation
    return NextResponse.json({ received: true }, { status: 200 })
  }

  // ── 5a. Dedup webhooks using a content hash, not payload.id ──────────────
  //    Most providers retry failed webhooks several times (exponential backoff).
  //    A successful DB write that times out before the response window
  //    generates retries — all of which we must discard after the first success.
  //
  //    Previously keyed on payload.id directly. That field's semantics are
  //    NOT consistent even within a single provider — Hospitable's own docs
  //    describe `id` as a unique-per-delivery ULID, but
  //    docs/Integrations/hospitable/api-reference.md:522 documents
  //    reservation.changed specifically as sending the reservation's own
  //    (stable, reused) id in that same field. Those claims contradict each
  //    other and have not been empirically re-verified (see Task 1 in
  //    CLAUDE_HOSPITABLE_DEXIE_AUDIT_FIXES_1.md). If the second claim is
  //    true, keying on payload.id meant every real reservation.changed
  //    webhook after the first one for a given reservation, within the 72h
  //    TTL, silently collided on this table's primary key and was
  //    discarded as a duplicate — never reaching handleWebhookEvent at all.
  //
  //    A hash of the parsed payload is correct regardless of which claim is
  //    true: a genuine retry resends identical content (Hospitable's
  //    documented retry behavior), so it still collides on the hash and is
  //    still deduped; two distinct real changes to the same entity always
  //    differ in `created` and/or `data`, so they hash differently and are
  //    never conflated. JSON.stringify is deterministic for a given parsed
  //    object, and a retry redelivers the exact same JSON structure/values
  //    as the original, so hashing the already-parsed `payload` here is
  //    safe without a second raw-body read.
  const dedupSource = JSON.stringify(payload)
  const webhookId    = createHash('sha256').update(dedupSource).digest('hex')

  {
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
      reportError(new Error(dedupErr.message), { site: 'webhook.provider.dedup_insert', extra: { provider: providerId } })
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
  //    OwnerRez's real non-revocation actions, per OwnerRez's own webhooks
  //    doc (2026-07-16): entity_update/entity_delete, plus a create action
  //    the doc names inconsistently within itself (entity_create in the
  //    Actions reference table, entity_insert in the "keeping track of
  //    blocks/bookings" walkthrough) — see ownerrez.ts's handleWebhookEvent,
  //    which accepts both rather than guessing. entity_type is carried
  //    separately (booking/guest/property/inquiry/quote/thread_message —
  //    'review' is not a valid entity_type at all). These are delivered to
  //    whatever single URL is configured in the OAuth app's Developer/API
  //    settings page in the OwnerRez dashboard, not via a per-connection
  //    subscription API call.
  //
  //    We always return 200 quickly and offload heavy processing to Inngest.
  try {
    await providerAdapter.handleWebhookEvent({ action, payload, externalUserId, correlationId })
  } catch (err) {
    // Again: log, don't 500 — provider is not responsible for our processing errors
    console.error(`[Webhook:${providerId}] Handler threw for action "${action}":`, err)
    reportError(err, { site: 'webhook.provider.handler', extra: { provider: providerId, action: safeAction } })
  }

  return NextResponse.json({ received: true }, { status: 200 })
}
