import { describe, it, expect } from 'vitest'

import {
  isNextControlFlow,
  isServerActionProbe,
  shouldDropSentryEvent,
} from '@/lib/observability/sentry-filters'

// ============================================================================
// EVERY PREDICATE HERE DISCARDS A SENTRY EVENT.
//
// So the tests that matter most are the NEGATIVE ones. A filter that is too
// eager fails in the one way nobody notices: the report never arrives, and the
// absence of an alert looks exactly like the absence of a problem. Each
// describe block therefore pairs what is dropped with what must survive.
// ============================================================================

describe('isNextControlFlow', () => {
  it('drops redirect() and notFound(), which are control flow, not failures', () => {
    expect(isNextControlFlow({ digest: 'NEXT_REDIRECT;push;/login;307' })).toBe(true)
    expect(isNextControlFlow({ digest: 'NEXT_NOT_FOUND' })).toBe(true)
  })

  it('keeps anything else, including a digest-bearing real error', () => {
    expect(isNextControlFlow({ digest: '3899168915' })).toBe(false)
    expect(isNextControlFlow(new Error('permission denied for table vendors'))).toBe(false)
    expect(isNextControlFlow(null)).toBe(false)
    expect(isNextControlFlow('NEXT_REDIRECT')).toBe(false)
  })
})

describe('isServerActionProbe', () => {
  it('drops the POST-to-a-page-with-no-action error', () => {
    // Verbatim from CUSHION-10, 2026-09-12: seven of these in six seconds
    // against the marketing homepage, which has no Server Action to invoke.
    expect(isServerActionProbe(new Error(
      'Failed to find Server Action. This request might be from an older or newer deployment. ' +
      'Read more: https://nextjs.org/docs/messages/failed-to-find-server-action'
    ))).toBe(true)
  })

  it('does not drop a real failure that merely mentions a server action', () => {
    // The filter matches the START of the message, so an application error
    // whose text happens to contain the phrase still reports.
    expect(isServerActionProbe(new Error(
      'createCheckoutSession: Failed to find Server Action handler for the portal redirect'
    ))).toBe(false)
  })

  it('keeps unrelated errors and non-errors', () => {
    expect(isServerActionProbe(new Error('Failed to fetch'))).toBe(false)
    expect(isServerActionProbe({ message: 42 })).toBe(false)
    expect(isServerActionProbe(undefined)).toBe(false)
  })
})

describe('shouldDropSentryEvent', () => {
  it('drops what either predicate drops', () => {
    expect(shouldDropSentryEvent({ digest: 'NEXT_REDIRECT;push;/onboarding;307' })).toBe(true)
    expect(shouldDropSentryEvent(new Error('Failed to find Server Action.'))).toBe(true)
  })

  it('lets a genuine application error through — the case that must never regress', () => {
    expect(shouldDropSentryEvent(new Error('permission denied for table work_orders'))).toBe(false)
    expect(shouldDropSentryEvent(new Error('Watchdog: 1 scheduled job(s) slow'))).toBe(false)
  })
})
