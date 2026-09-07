// lib/inngest/reconnect-required.ts
// ============================================================================
// The one terminal failure that is not ours: an integration whose credential
// the provider will no longer accept.
//
// ── Why this needs its own type of failure ──────────────────────────────────
//
// A revoked or missing OAuth grant is already handled correctly everywhere it
// occurs: the connection row is marked, the PM is notified once (throttled),
// an audit row is written, and the run ends with a NonRetriableError so
// Inngest records a terminal failure instead of retrying a credential that
// cannot come back.
//
// What was missing is how that arrives on OUR side. Every terminal failure —
// retriable or not — passes through on-failure.ts, which captures it to Sentry
// as `[Inngest] <fn> exhausted all retries: <message>`. For this class that
// sentence is false twice over: a NonRetriableError exhausts nothing (it opts
// out of the retry policy), and nothing failed on our side at all. Worse, the
// two OwnerRez sync functions are in CRITICAL_FUNCTION_IDS, so one customer
// letting an OwnerRez authorization lapse sent the founder a
// "🚨 Critical job failed" email — for a condition only that customer can fix,
// and which they had already been emailed about.
//
// Sentry, 2026-08-19: `[Inngest] fieldstay-ownerrez-connection-sync exhausted
// all retries: OwnerRez authorization expired — reconnect your account to
// resume syncing`, filed as an error, twice.
//
// ── Why a marker in the message rather than the error's type ────────────────
//
// on-failure.ts does not receive the thrown Error. It receives Inngest's
// `inngest/function.failed` event, whose `error` is a SERIALIZED
// {name, message, stack} — and the name does not survive: the production event
// for the failure above carried `original_error_name: "Error"` despite a
// NonRetriableError having been thrown. The message is the only field that
// arrives intact, so the marker lives there.
//
// It is a machine-readable prefix, not prose, so the check cannot be satisfied
// by wording that merely resembles it, and on-failure.ts strips it before the
// message is shown anywhere.
// ============================================================================

import { NonRetriableError } from 'inngest'

/**
 * Prefix identifying a terminal failure the PM resolves by reconnecting.
 * Never shown to anyone: on-failure.ts strips it, and the PM-facing sentence
 * (translateSyncError's) is written to the connection row separately.
 */
export const RECONNECT_REQUIRED_MARKER = '[reconnect-required]'

/**
 * The error to throw when a provider has stopped accepting a connection's
 * credential and only the PM reconnecting will change that.
 *
 * Still a NonRetriableError, so nothing about the Inngest-side contract
 * changes — the run is terminal, appears as a failure in the dashboard, and
 * fires `inngest/function.failed` exactly as before.
 */
export function reconnectRequired(message: string): NonRetriableError {
  return new NonRetriableError(`${RECONNECT_REQUIRED_MARKER} ${message}`)
}

/** True for a failure message produced by `reconnectRequired()`. */
export function isReconnectRequired(message: string): boolean {
  return message.startsWith(RECONNECT_REQUIRED_MARKER)
}

/** The message without the marker, for anything a human reads. */
export function stripReconnectRequiredMarker(message: string): string {
  return isReconnectRequired(message)
    ? message.slice(RECONNECT_REQUIRED_MARKER.length).trimStart()
    : message
}
