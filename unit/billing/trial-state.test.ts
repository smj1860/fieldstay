import { describe, it, expect } from 'vitest'
import { trialState, TRIAL_WARNING_DAYS, TRIAL_DAYS } from '@/lib/billing/trial'

// ============================================================================
// Trial timing drives two things that must never disagree: the billing gate in
// app/(dashboard)/layout.tsx, which locks a PM out of their own dashboard, and
// the countdown banner that warns them it is coming. Both now read this
// function, so its edges are the product's edges.
//
// The warning email had NO coverage of this kind, and that is part of why it
// went unnoticed that it never sent at all: `billing/trial-lifecycle-start` was
// only ever emitted by the Stripe webhook, for a Stripe-side trial FieldStay
// does not create. Nothing asserted anybody was told anything.
// ============================================================================

const AT = (iso: string) => new Date(iso)
const NOW = AT('2026-08-28T00:00:00.000Z')

describe('trialState', () => {
  it('is idle when the org is not trialing, whatever the date says', () => {
    // A paid org keeps a stale trial_ends_at forever — production has several.
    // Reading the date without the status would wall a paying customer.
    const s = trialState('active', '2026-01-01T00:00:00.000Z', NOW)
    expect(s).toEqual({ inTrial: false, expired: false, daysLeft: 0, showWarning: false })
  })

  it('is idle when trialing with no end date at all', () => {
    expect(trialState('trialing', null, NOW).expired).toBe(false)
  })

  it('reports expired once the end date has passed', () => {
    const s = trialState('trialing', '2026-08-27T23:59:59.000Z', NOW)
    expect(s.expired).toBe(true)
    expect(s.inTrial).toBe(false)
    // No warning on an expired trial: the wall is already up, and a banner
    // saying "0 days left" on a blocked account is noise on top of a block.
    expect(s.showWarning).toBe(false)
  })

  it('treats the exact expiry instant as expired, not as a live trial', () => {
    // The boundary decides whether a PM gets one more page load. Locking at
    // the instant matches the gate's original `< new Date()` comparison.
    expect(trialState('trialing', NOW.toISOString(), NOW).expired).toBe(true)
  })

  it('counts a partial final day as one day, not zero', () => {
    // The live case that prompted this: 18h24m remaining. Flooring reads
    // "0 days left" on an account that still works for most of a business day,
    // which is both wrong and alarming.
    const s = trialState('trialing', '2026-08-28T18:24:58.000Z', NOW)
    expect(s.daysLeft).toBe(1)
    expect(s.inTrial).toBe(true)
    expect(s.showWarning).toBe(true)
  })

  it('shows the warning exactly at the threshold and not a day earlier', () => {
    const atThreshold = new Date(NOW.getTime() + TRIAL_WARNING_DAYS * 86_400_000)
    expect(trialState('trialing', atThreshold.toISOString(), NOW).showWarning).toBe(true)

    // One second past the threshold rounds up to WARNING_DAYS + 1.
    const justOutside = new Date(atThreshold.getTime() + 1_000)
    const outside = trialState('trialing', justOutside.toISOString(), NOW)
    expect(outside.showWarning).toBe(false)
    expect(outside.inTrial).toBe(true)
  })

  it('does not warn at the start of a fresh trial', () => {
    // The control. Without it, a rule that always warned would pass every
    // assertion above — and every org would see a countdown from day one.
    const fresh = new Date(NOW.getTime() + TRIAL_DAYS * 86_400_000)
    const s = trialState('trialing', fresh.toISOString(), NOW)
    expect(s.inTrial).toBe(true)
    expect(s.showWarning).toBe(false)
    expect(s.daysLeft).toBe(TRIAL_DAYS)
  })

  it('treats an unparseable date as no trial rather than as expired', () => {
    // Fails OPEN on purpose. A malformed timestamp locking a customer out of
    // their account is a far worse outcome than one extra day of access, and
    // NaN comparisons are silently false in the direction that would have
    // walled them.
    const s = trialState('trialing', 'not-a-date', NOW)
    expect(s.expired).toBe(false)
    expect(s.inTrial).toBe(false)
  })
})
