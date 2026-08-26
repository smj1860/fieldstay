// lib/integrations/connection-revoked.ts
// ============================================================================
// What happens when Hospitable stops accepting a connection's token.
//
// Written for Hospitable and generalised the same week, because the identical
// gap was open for Hostex and Hostaway: a grep for `status: 'revoked'` returned
// OwnerRez x3, Kroger x1 and the token-refresh cron x1, and NOTHING for the
// other three providers. Hostex is the sharpest version — it already had
// isHostexAccountActionError(), documented as the errors that "must not be
// buried in a step-failure log", with ZERO callers. The classifier was built
// and the wiring was never done.
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// Found 2026-08-26 from a Sentry cluster: one org's Hospitable connection had
// been returning 401 "Unauthenticated" since 2026-08-22 across three separate
// cron handlers, and in production it was STILL `status: 'active'` with
// `reconnect_email_sent_at` null. Four days, and nothing had told the customer
// their integration was dead.
//
// It was not one missing branch. NO Hospitable path anywhere marked a
// connection revoked — `grep "status: 'revoked'"` returned OwnerRez ×3, Kroger
// ×1, the token-refresh cron ×1, and nothing for Hospitable — and the three
// callers of shouldNotifyConnectionError were all OwnerRez. So the notify
// machinery already existed and simply had no Hospitable caller.
//
// The token-refresh cron does not cover this either: it is the only thing that
// sets `reconnect_email_sent_at`, and it acts on tokens it can refresh. A
// Hospitable subscription that lapses rejects the token outright, which that
// cron never sees.
//
// ── Why this is a module of PURE async functions ────────────────────────────
//
// Same reason as lib/integrations/connection-error-notify.ts, whose contract
// this follows: every export here is ordinary database work that is safe to
// call inside a `step.run`, and NONE of it touches Inngest step tooling. The
// caller's `step.run` returns a DECISION and the `step.sendEvent` happens at
// the function's top level.
//
// That split is load-bearing, not stylistic. Hiding a send inside a helper is
// exactly how ownerrez-reviews-sync.ts nested step tooling without any lexical
// scan seeing it, and every connection revocation wrote two audit rows as a
// result. Do not add a `step` parameter to anything in this file.
// unit/guardrails/inngest-nested-steps.test.ts fails if you do.
// ============================================================================

import type { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { mergeIntegrationConnectionMetadata } from '@/lib/integrations/connection-metadata'
import { shouldNotifyConnectionError } from '@/lib/integrations/connection-error-notify'
import { translateSyncError, syncErrorDetail } from '@/lib/integrations/types'

type ServiceClient = ReturnType<typeof createServiceClient>

/**
 * Is this the provider refusing the credential, rather than a transient fault?
 *
 * Message-based, because Hospitable and Hostaway both throw plain Errors
 * carrying the status — `[Hospitable] GET /teammates failed (401): ...` and
 * `Hostaway listings fetch failed (401): ...`. Hostex is the exception: it
 * raises a typed HostexApiError with an `errorCode`, so its call sites pair
 * this with isHostexAccountActionError(), which is both more precise and the
 * only way to catch its 420 (subscription expired / account suspended) — a
 * code no message pattern would recognise as needing the host's attention.
 *
 * That pairing is deliberate rather than lazy: importing a provider adapter
 * into this module would make a shared helper depend on one provider's error
 * class, and the next provider would add another import.
 *
 * 402 is included and is the case that prompted this. A lapsed Hospitable
 * subscription answers `{"status_code":402,"reason_phrase":"Subscription not
 * active"}`, which is NOT an expired token — but the remediation the PM needs
 * is identical (fix the account, reconnect), and leaving it out would have left
 * the exact production incident uncovered.
 *
 * 404 is deliberately NOT here. A single missing property means that property
 * is gone, not that the connection is broken, and treating it as a revocation
 * would disconnect a healthy integration over one stale id.
 */
export function isProviderAuthFailure(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  // Matched by POSITION, not as a bare substring. `msg.includes('401')` also
  // fires on `GET /reservations/1401234/messages failed (404)` — a reservation
  // id that happens to contain the digits — which would revoke a healthy
  // connection over a missing record. The shapes the adapters actually emit are
  // a parenthesised status, a JSON status_code, and Hostex's error_code.
  if (/\((?:401|402|403)\)/.test(msg)) return true
  if (/"status_code"\s*:\s*(?:401|402|403)\b/.test(msg)) return true
  if (/\berror_code\s+(?:401|403|420)\b/.test(msg)) return true

  return /\b(?:unauthenticated|unauthorized|forbidden)\b/.test(msg)
    || msg.includes('subscription not active')
}

export interface RevokedDecision {
  /** The connection row, for the caller's throttle-recording step. */
  connectionId: string
  /** PM-facing wording. Never carries a credential — see syncErrorDetail. */
  humanError: string
}

/**
 * Mark the connection revoked, record why, and decide whether to notify.
 *
 * Returns the decision when a PM notification is DUE, or null when the 4-hour
 * throttle says one already went out. The caller sends the event itself.
 *
 * NON-THROWING on the notify decision specifically: shouldNotifyConnectionError
 * fails open, so a milestone read error costs a repeat notification rather than
 * silence. The status write above it DOES throw, because a connection left
 * `active` is the whole defect this module exists to fix and failing quietly
 * would reproduce it.
 */
export async function markProviderConnectionRevoked(
  admin:  ServiceClient,
  params: {
    userId: string
    orgId:  string
    /** The integration_connections.provider_id value, e.g. 'hospitable'. */
    providerId: string
    /** How the provider is named to the PM, e.g. 'Hostex'. */
    providerLabel: string
    err:  unknown
    site: string
  },
): Promise<RevokedDecision | null> {
  const humanError = translateSyncError(params.err, params.providerLabel)

  const { data: existing, error: lookupErr } = await admin
    .from('integration_connections')
    .select('id')
    .eq('user_id',     params.userId)
    .eq('provider_id', params.providerId)
    .maybeSingle()

  if (lookupErr) {
    throw new Error(`[${params.providerLabel}:${params.userId}] Connection lookup failed: ${lookupErr.message}`)
  }

  await mergeIntegrationConnectionMetadata({
    userId:     params.userId,
    providerId: params.providerId,
    patch: {
      last_sync_status: 'error',
      last_sync_error:  humanError,
      last_synced_at:   new Date().toISOString(),
    },
    status: 'revoked',
  })

  await logAuditEvent({
    orgId:      params.orgId,
    actorId:    params.userId,
    action:     'integration.sync_failed',
    targetType: 'integration_connection',
    targetId:   params.providerId,
    // syncErrorDetail truncates and never interpolates a credential. Keep it
    // that way: this lands in audit metadata, which staff read.
    metadata:   { provider_id: params.providerId, reason: 'token_revoked', detail: syncErrorDetail(params.err) },
  })

  if (!existing?.id) return null

  const due = await shouldNotifyConnectionError(admin, {
    orgId:        params.orgId,
    connectionId: existing.id,
    site:         params.site,
  })

  return due ? { connectionId: existing.id, humanError } : null
}
