import { describe, it, expect } from 'vitest'
import { crewInviteIsExpired, CREW_INVITE_TTL_MS } from '@/lib/crew/invite-expiry'

// ============================================================================
// This rule had two implementations that disagreed, and the disagreement was
// the exact hole one of them was written to close.
//
// app/crew-invite/[token]/actions.ts falls back to created_at when
// invite_sent_at is NULL, because a NULL there meant a PERMANENTLY valid
// activation token that mints a real auth account, and a large share of live
// crew_members rows carry that NULL (invited by SMS, or created before the
// column existed).
//
// app/crew-invite/[token]/page.tsx kept the original shape — it only ran an
// expiry check `if (crew.invite_sent_at)` at all — so a NULL row of any age
// rendered a working activation form. Not exploitable (the action is the real
// gate) but the crew member filled in a password before being told the link
// was dead, and it was 5 of the 8 invites pending in production.
//
// One helper now, both call sites. These pin the fallback so the page cannot
// quietly drift back.
// ============================================================================

const DAY = 86_400_000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

describe('crewInviteIsExpired', () => {
  it('accepts a freshly sent invite', () => {
    expect(crewInviteIsExpired(iso(1 * DAY), iso(1 * DAY))).toBe(false)
  })

  it('expires an invite past the TTL', () => {
    expect(crewInviteIsExpired(iso(8 * DAY), iso(8 * DAY))).toBe(true)
  })

  it('uses the TTL boundary the constant declares', () => {
    expect(crewInviteIsExpired(iso(CREW_INVITE_TTL_MS - 60_000), null)).toBe(false)
    expect(crewInviteIsExpired(iso(CREW_INVITE_TTL_MS + 60_000), null)).toBe(true)
  })

  // The whole reason this file exists. A NULL invite_sent_at is common, not
  // exceptional, and it must not mean "never expires".
  it('falls back to created_at when invite_sent_at is NULL', () => {
    expect(crewInviteIsExpired(null, iso(1 * DAY))).toBe(false)
    expect(crewInviteIsExpired(null, iso(30 * DAY))).toBe(true)
  })

  it('prefers invite_sent_at over created_at when both are present', () => {
    // Row created long ago, invite re-sent yesterday — still valid.
    expect(crewInviteIsExpired(iso(1 * DAY), iso(90 * DAY))).toBe(false)
  })

  it('treats a row with neither timestamp as expired (fails closed)', () => {
    expect(crewInviteIsExpired(null, null)).toBe(true)
  })

  // NaN loses every comparison, so `issuedMs + TTL < Date.now()` reads a
  // corrupt timestamp as "not expired" — failing OPEN on the one input we
  // understand least. Number.isFinite is the only guard that catches it.
  it.each([
    ['not a date', 'not-a-date'],
    ['empty-ish',  'undefined'],
  ])('treats an unparseable %s timestamp as expired, not as valid', (_label, value) => {
    expect(crewInviteIsExpired(value, null)).toBe(true)
    expect(crewInviteIsExpired(null, value)).toBe(true)
  })
})
