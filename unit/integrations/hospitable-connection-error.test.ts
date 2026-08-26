import { describe, it, expect } from 'vitest'

import { isHospitableAuthFailure } from '@/lib/integrations/hospitable-connection-error'

// ============================================================================
// The classifier that decides whether a Hospitable failure means "this
// connection is dead" or "this call went wrong".
//
// Getting it wrong is expensive in BOTH directions, which is why the negatives
// below matter as much as the positives:
//
//   too narrow -> the 2026-08-22 incident repeats. One org's connection 401ed
//                 for four days, stayed `status: 'active'`, and nobody told the
//                 customer.
//   too wide   -> a healthy integration is revoked over a transient fault, and
//                 the PM has to re-authorise for nothing.
// ============================================================================

describe('isHospitableAuthFailure', () => {
  it.each([
    // The exact strings the adapters produced in production.
    ['401 from /teammates',    '[Hospitable] GET /teammates failed (401): {"message":"Unauthenticated."}'],
    ['401 from /reservations', 'Hospitable /reservations failed (401): {"message":"Unauthenticated."}'],
    // A lapsed subscription. NOT an expired token, but the remediation the PM
    // needs is identical, and leaving it out would have left the incident that
    // prompted this module uncovered.
    ['402 subscription lapsed', 'Hospitable /reservations failed (402): {"status_code":402,"reason_phrase":"Subscription not active"}'],
    ['403 forbidden',           '[Hospitable] GET /properties failed (403): forbidden'],
  ])('treats %s as a dead connection', (_label, message) => {
    expect(isHospitableAuthFailure(new Error(message))).toBe(true)
  })

  it.each([
    // A single missing listing is not a broken connection. Revoking here would
    // disconnect a healthy integration over one stale property id — which is
    // why calendar-sync handles ProviderEntityGoneError separately, inside its
    // fetch step, rather than letting it reach this classifier.
    ['404 on one property', '[Hospitable] GET /properties/abc/calendar failed (404): {"status_code":404}'],
    ['429 rate limit',      'Rate limited — retry after 2s'],
    ['500 from provider',   '[Hospitable] GET /reservations failed (500): upstream error'],
    ['a network timeout',   'fetch failed: ETIMEDOUT'],
    ['a database error',    'reservation_messages upsert failed: duplicate key value'],
  ])('leaves %s alone', (_label, message) => {
    expect(isHospitableAuthFailure(new Error(message))).toBe(false)
  })

  it('reads a non-Error too — a step carries its failure out as a string', () => {
    // Inngest serialises a step's return value as JSON, so a caller that
    // decides inside a step can only carry the MESSAGE across the boundary.
    expect(isHospitableAuthFailure('GET /teammates failed (401)')).toBe(true)
    expect(isHospitableAuthFailure('GET /teammates failed (500)')).toBe(false)
  })

  it('does not fire on a 404 whose RESOURCE ID merely contains the digits', () => {
    // The false positive a bare `msg.includes('401')` would produce, and the
    // reason the classifier matches on position instead. A reservation id like
    // 1401234 in a 404 must not revoke a healthy connection — and Hospitable
    // reservation ids really are long numerics: 1262483200 is the one from the
    // CUSHION-9 incident.
    expect(isHospitableAuthFailure(new Error('GET /reservations/1401234/messages failed (404)'))).toBe(false)
    expect(isHospitableAuthFailure(new Error('GET /reservations/4021/messages failed (404)'))).toBe(false)
  })
})
