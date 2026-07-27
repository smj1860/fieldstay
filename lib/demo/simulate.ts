import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import type { DemoSideEffectKind } from '@/types/database'

/**
 * Demo-safe side-effect wrapper.
 *
 * Wraps any call that reaches a real human — Telnyx SMS, guest/vendor-facing
 * Resend email, a Stripe payout — so that in the roadshow demo org it is
 * recorded in demo_activity_log and answered with a realistic mock instead of
 * dispatched. The UI completes exactly as it does in production; the fake
 * `555` phone numbers and `@example.com` addresses in the seed data never
 * produce a bounce, a misdirected text, or a deliverability hit.
 *
 * Deliberately NOT applied to internal PM-facing notifications (digest email
 * to the operator running the booth) — those are useful to actually receive.
 */

export interface SimulatedSideEffect {
  orgId:   string
  kind:    DemoSideEffectKind
  payload: Record<string, unknown>
}

/**
 * @param isDemo     org.is_demo for the org owning this side effect. When
 *                   false this is a straight pass-through to realSend.
 * @param effect     what to record. Payload must already be redacted — see
 *                   the PII note below.
 * @param realSend   the production call, invoked only when !isDemo.
 * @param mockResult what realSend would have returned, shaped identically so
 *                   callers need no demo-specific branching downstream.
 */
export async function simulateOrSend<T>(
  isDemo:     boolean,
  effect:     SimulatedSideEffect,
  realSend:   () => Promise<T>,
  mockResult: T,
): Promise<T> {
  if (!isDemo) return realSend()

  // System context: this runs beneath already-authorized callers (Inngest
  // steps, server actions that ran requireOrgMember) and writes only to a
  // table with no INSERT policy, so the service client is the only writer.
  const supabase = createServiceClient({ system: 'lib/demo/simulate' })

  const { error } = await supabase.from('demo_activity_log').insert({
    org_id:       effect.orgId,
    kind:         effect.kind,
    payload:      effect.payload,
    simulated_at: new Date().toISOString(),
  })

  if (error) {
    // Fail OPEN, but loudly. A logging failure must never break the demo in
    // front of an audience — the send was already suppressed by the time we
    // got here, so the safety property holds regardless of whether the row
    // landed. Log the kind and org only, never the payload: it carries the
    // very phone numbers and message bodies the send-path is careful not to
    // log (see lib/sms/telnyx.ts's redaction).
    console.error('[demo] failed to log simulated side effect', {
      kind:  effect.kind,
      orgId: effect.orgId,
      error: error.message,
    })
  }

  return mockResult
}

/**
 * Redacts a phone number to its last 4 digits for demo_activity_log payloads.
 * Seeded demo numbers are fake `555` numbers, but this path is shared with
 * the real send helpers and must not become the one place a live guest
 * number gets persisted in cleartext if the flag is ever set on a real org.
 */
export function redactPhone(e164: string): string {
  return `***${e164.slice(-4)}`
}

/** Same rationale as redactPhone, for email addresses. */
export function redactEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '***'
  return `${local.slice(0, 2)}***@${domain}`
}
