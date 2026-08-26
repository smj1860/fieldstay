import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import { ROOT, balancedEnd, readBlanked, readCode } from './scan'

// ============================================================================
// A DEAD PROVIDER CONNECTION MUST REACH THE CUSTOMER.
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
// Hostex is the sharpest version of the same story: it already had
// isHostexAccountActionError(), documented as the errors that "must not be
// buried in a step-failure log" and covering error_code 420 (subscription
// expired / account suspended), with ZERO callers. The classifier was built and
// the wiring was never done — which nothing catches, because unreferenced-
// server-actions only covers Server Actions, not lib helpers.
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
  'lib/inngest/functions/hostex/reservation-reconcile-handler.ts',
  'lib/inngest/functions/hostaway/incremental-sync-handler.ts',
  'lib/inngest/functions/hostaway/reservation-reconcile-handler.ts',
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
  'lib/inngest/functions/hostex/initial-sync.ts':
    'Runs on integration/hostex.connected, with the PM watching the connect flow.',
  'lib/inngest/functions/hostex/webhook-handler.ts':
    'Inbound webhook, not an outbound authenticated call — it cannot produce a '
    + 'token rejection, and the daily reconcile above covers the connection.',
  'lib/inngest/functions/hostaway/initial-sync.ts':
    'Runs on integration/hostaway.sync.requested at connect time, with the PM watching.',
}

const codeOf = (relPath: string) => readCode(join(ROOT, relPath))

describe('guardrail: a revoked Hospitable connection notifies the PM', () => {
  it.each(MUST_NOTIFY)('%s classifies an auth failure', (relPath) => {
    expect(
      codeOf(relPath),
      `${relPath} never calls isProviderAuthFailure, so a 401/402/403 from `
      + 'the provider is indistinguishable from a transient fault and the '
      + 'connection stays marked active forever.',
    ).toContain('isProviderAuthFailure')
  })

  it.each(MUST_NOTIFY)('%s runs the revoke-and-notify sequence', (relPath) => {
    expect(
      codeOf(relPath),
      `${relPath} detects the auth failure but never calls revokeAndNotify, so the `
      + 'connection stays marked active and the customer is never told to reconnect '
      + '— exactly the state production was found in.',
    ).toMatch(/revokeAndNotify\s*\(/)
  })

  it.each(MUST_NOTIFY)('%s calls it at the TOP LEVEL, not inside a step.run', (relPath) => {
    // The invariant that replaced "the helper never mentions step". Sharing the
    // sequence is fine — six copies of it scored 25.5% duplicated lines on new
    // code, with one file at 88.5%. What is NOT fine is calling it from inside a
    // step.run callback: that registers a new step op mid-callback, unwinds the
    // request, and re-runs the callback from the top on the next pass, replaying
    // every side effect written before it. That is the ownerrez-reviews-sync bug
    // exactly, and it is invisible to a lexical scan for `step.` in the handler.
    const code = readBlanked(join(ROOT, relPath))

    for (const m of code.matchAll(/\bstep\.run\s*\(/g)) {
      const open = code.indexOf('(', m.index)
      const body = code.slice(open, balancedEnd(code, open))
      expect(
        /revokeAndNotify\s*\(/.test(body),
        `${relPath} calls revokeAndNotify inside a step.run callback (the one opened `
        + `at line ${code.slice(0, m.index).split('\n').length}). It performs step `
        + 'tooling; nesting it re-runs the enclosing callback and replays its side '
        + 'effects. Move the call to the function\'s top level.',
      ).toBe(false)
    }
  })

  it('the shared sequence does all three things, in the right order', () => {
    // One place now, so this is checked once rather than six times — but it has
    // to be checked, because collapsing six copies into one helper means one
    // silent edit can now break every provider at once.
    const helper = codeOf('lib/inngest/functions/shared/revoke-and-notify.ts')

    // Matched as CALLS. Searching for the bare name finds the `import` line
    // first, which sits above everything and makes any ordering assertion
    // meaningless — this test failed that way on its first run, reporting the
    // throttle as recorded before the send because it had found the import at
    // character 262. The same trap took two other checks in this file.
    const markIdx   = helper.search(/markProviderConnectionRevoked\s*\(/)
    const sendIdx   = helper.indexOf("name: 'integration/connection.error'")
    const recordIdx = helper.search(/recordConnectionErrorNotified\s*\(/)

    expect(markIdx,   'the helper no longer marks the connection revoked').toBeGreaterThan(-1)
    expect(sendIdx,   'the helper no longer emits integration/connection.error').toBeGreaterThan(-1)
    expect(recordIdx, 'the helper no longer records the throttle').toBeGreaterThan(-1)

    expect(sendIdx, 'the helper sends BEFORE it decides').toBeGreaterThan(markIdx)
    expect(recordIdx, 'the helper records the throttle BEFORE it sends, so a repeat is suppressed')
      .toBeGreaterThan(sendIdx)
  })

  it('the shared sequence keeps the send OUT of a step.run callback', () => {
    // Same check as the call sites, applied to the helper itself: the decision
    // comes out of a step.run and the send happens between two steps.
    const code = readBlanked(join(ROOT, 'lib/inngest/functions/shared/revoke-and-notify.ts'))

    for (const m of code.matchAll(/\bstep\.run\s*\(/g)) {
      const open = code.indexOf('(', m.index)
      const body = code.slice(open, balancedEnd(code, open))
      expect(
        /step\.sendEvent\s*\(/.test(body),
        'revoke-and-notify.ts nests sendEvent inside a step.run — the exact shape '
        + 'that made every OwnerRez revocation write two audit rows.',
      ).toBe(false)
    }
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

  it('Hostex pairs its typed classifier with the shared one', () => {
    // isProviderAuthFailure matches on the message. That covers Hospitable and
    // Hostaway, which throw plain Errors carrying the status — but Hostex
    // raises a typed HostexApiError, and error_code 420 ("subscription expired
    // / account suspended") is not something a status pattern recognises as
    // needing the host's attention. Dropping this pairing would silently stop
    // catching the case Hostex's own docs are most emphatic about.
    // Matched as a CALL, not as a bare name. The first version of this check
    // used toContain('isHostexAccountActionError'), which the `import` line
    // satisfies on its own — so deleting the call while leaving the import
    // (exactly what a careless edit does) left this test green. Verified by
    // canary: the bare-name version did not fire, this one does.
    expect(
      codeOf('lib/inngest/functions/hostex/reservation-reconcile-handler.ts'),
      'The Hostex handler no longer CALLS isHostexAccountActionError, so a 420 '
      + '(subscription expired) reaches nobody.',
    ).toMatch(/isHostexAccountActionError\s*\(/)
  })

  it('the CLASSIFIER module stays free of step tooling', () => {
    // connection-revoked.ts is the decision half — plain database work, safe to
    // call inside a step.run. The step tooling lives one layer up in
    // functions/shared/revoke-and-notify.ts, which is called at the top level.
    // Collapsing those two layers back together would put step tooling in a
    // module that callers legitimately invoke from inside a step.
    expect(
      codeOf('lib/integrations/connection-revoked.ts'),
      'connection-revoked.ts references Inngest step tooling. It is called from '
      + 'inside step.run callbacks, so step tooling here IS nesting.',
    ).not.toMatch(/\bstep\s*[.:]/)
  })
})
