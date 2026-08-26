import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import { ROOT, readCode } from './scan'

// ============================================================================
// A DEAD HOSPITABLE CONNECTION MUST REACH THE CUSTOMER.
//
// Found 2026-08-26 in production: one org's Hospitable connection had returned
// 401 "Unauthenticated" since 2026-08-22 across three separate cron handlers,
// and the row was STILL `status: 'active'` with `reconnect_email_sent_at` null.
// Four days of a broken integration, and nothing had told the customer.
//
// It was not a missing branch. It was a missing PROVIDER: grepping
// `status: 'revoked'` returned OwnerRez x3, Kroger x1 and the token-refresh
// cron x1, with nothing for Hospitable, and all three callers of
// shouldNotifyConnectionError were OwnerRez. The notify machinery existed and
// simply had no Hospitable caller — which is invisible unless something counts.
//
// The token-refresh cron does not cover this: it is the only thing that sets
// reconnect_email_sent_at, and it acts on tokens it can refresh. A lapsed
// Hospitable subscription rejects the token outright, so that cron never sees
// it.
//
// This pins the wiring per handler rather than as a total, because a total
// stays green while the coverage moves from one file to another.
// ============================================================================

/**
 * The CRON-FANNED handlers. These are the silent ones: a cron fires them per
 * connection with no human watching, so a dead token produces Sentry noise and
 * nothing else until someone reads it.
 */
const MUST_NOTIFY = [
  'lib/inngest/functions/hospitable/teammate-sync-handler.ts',
  'lib/inngest/functions/hospitable/calendar-sync-handler.ts',
  'lib/inngest/functions/hospitable/reservation-reconcile-handler.ts',
] as const

/**
 * Deliberately NOT wired, each for a stated reason. This list is the record of
 * a decision — an entry may be removed by wiring the file, never added to
 * quietly.
 */
const NOT_WIRED: Record<string, string> = {
  'lib/inngest/functions/hospitable/incremental-sync.ts':
    'Webhook-triggered, not cron-fanned, and 836 lines with many exit points. '
    + 'By the time a webhook fails here the daily crons above have already '
    + 'revoked the connection and notified, and the 4-hour throttle covers the '
    + 'overlap. Wrapping it is a larger, riskier edit for no additional signal.',
  'lib/inngest/functions/hospitable/initial-sync.ts':
    'Runs on integration/hospitable.connected — seconds after OAuth, with the '
    + 'PM watching the connect flow. A failure there surfaces in the UI.',
  'lib/inngest/functions/hospitable/hospitable-reviews-backfill.ts':
    'Same trigger, same reason as initial-sync.',
}

const codeOf = (relPath: string) => readCode(join(ROOT, relPath))

describe('guardrail: a revoked Hospitable connection notifies the PM', () => {
  it.each(MUST_NOTIFY)('%s classifies an auth failure', (relPath) => {
    expect(
      codeOf(relPath),
      `${relPath} never calls isHospitableAuthFailure, so a 401/402/403 from `
      + 'Hospitable is indistinguishable from a transient fault and the '
      + 'connection stays marked active forever.',
    ).toContain('isHospitableAuthFailure')
  })

  it.each(MUST_NOTIFY)('%s marks the connection revoked', (relPath) => {
    expect(
      codeOf(relPath),
      `${relPath} does not call markHospitableConnectionRevoked. Detecting the `
      + 'failure without recording it leaves the row `active`, which is exactly '
      + 'the state production was found in.',
    ).toContain('markHospitableConnectionRevoked')
  })

  it.each(MUST_NOTIFY)('%s sends the PM notification', (relPath) => {
    const code = codeOf(relPath)

    expect(
      code,
      `${relPath} revokes the connection but never emits `
      + 'integration/connection.error, so the customer is never told to reconnect '
      + '— the silence this guardrail exists to prevent.',
    ).toContain("name: 'integration/connection.error'")

    expect(
      code,
      `${relPath} sends the notification but never records it, so the 4-hour `
      + 'throttle in connection-error-notify.ts can never engage and every cron '
      + 'tick re-notifies.',
    ).toContain('recordConnectionErrorNotified')
  })

  it.each(MUST_NOTIFY)('%s keeps the send OUT of a step.run callback', (relPath) => {
    // The nesting ban has its own guardrail (inngest-nested-steps), but this
    // asserts the positive shape those handlers must keep: the step returns a
    // DECISION and the send happens after it. Hiding the send in a helper is
    // how ownerrez-reviews-sync nested step tooling invisibly and wrote two
    // audit rows per revocation.
    const code = codeOf(relPath)
    const sendIdx   = code.indexOf("name: 'integration/connection.error'")
    const decideIdx = code.indexOf('markHospitableConnectionRevoked')

    expect(sendIdx, `${relPath}: no send found`).toBeGreaterThan(-1)
    expect(
      sendIdx,
      `${relPath} emits integration/connection.error BEFORE it decides. The `
      + 'decision belongs in a step.run and the send at the top level after it.',
    ).toBeGreaterThan(decideIdx)
  })

  it('every excluded handler still exists, and none is silently in both lists', () => {
    // An exclusion naming a file that has moved is an exclusion covering
    // nothing, and the next handler to need one gets added to a list that
    // already looks considered.
    for (const relPath of Object.keys(NOT_WIRED)) {
      expect(
        () => codeOf(relPath),
        `NOT_WIRED names ${relPath}, which no longer exists — remove the stale entry.`,
      ).not.toThrow()

      expect(
        MUST_NOTIFY as readonly string[],
        `${relPath} is in BOTH lists.`,
      ).not.toContain(relPath)

      expect(NOT_WIRED[relPath]!.length, `${relPath} has no stated reason`).toBeGreaterThan(40)
    }
  })

  it('the shared helper takes no `step` — the send cannot migrate into it', () => {
    // The one way this wiring could regress without any of the checks above
    // failing: someone tidies the three copies into the helper, which would
    // take the step tooling with it and put the nesting straight back.
    const helper = codeOf('lib/integrations/hospitable-connection-error.ts')

    expect(helper, 'hospitable-connection-error.ts references Inngest step tooling')
      .not.toMatch(/\bstep\s*[.:]/)
  })
})
