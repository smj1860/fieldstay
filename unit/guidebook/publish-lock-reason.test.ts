import { describe, it, expect } from 'vitest'
import { publishLockReasonFor } from '@/app/(dashboard)/guidebook/guidebook-client'

// ============================================================================
// "I click the publish checkbox and nothing happens."
//
// It was disabled. `disabled={!isGuidebookActive}` with no explanation of its
// own — the only clue was a status banner at the top of the page, far above and
// outside the expanded per-property form. A disabled control that says nothing
// about why is indistinguishable from a broken one.
//
// Two things made it worse:
//
//   * The Save button was NOT disabled. The PM ticks a dead checkbox, saves,
//     gets a green "Saved", and reads that as published. The save was real —
//     it wrote is_published: false, because the checkbox never moved. The row
//     for "The lake house" showed exactly that: a fresh updated_at with
//     is_published still false.
//   * Publishing would not have made the URL live anyway. Both public routes
//     require `is_published AND guidebook_configurations.is_active`, so the
//     sponsor gate was always the real blocker — the checkbox was never the
//     thing standing in the way.
//
// This helper is the copy that now sits AT the control. Pure, so the wording
// can be asserted rather than eyeballed in a screenshot.
// ============================================================================

describe('publishLockReasonFor', () => {
  it('returns null when the guidebook is active — no lock, no message', () => {
    expect(publishLockReasonFor({
      isActive: true, gracePeriodEndsAt: null, sponsorsNeeded: 0,
    })).toBeNull()
  })

  it('stays silent when active even mid grace period', () => {
    // is_active is the single authority on whether publishing works. A grace
    // period with the guidebook still active must not warn about a lock that
    // is not in force — that is how a real warning gets ignored later.
    expect(publishLockReasonFor({
      isActive: true, gracePeriodEndsAt: '2026-09-01T00:00:00Z', sponsorsNeeded: 1,
    })).toBeNull()
  })

  it('names the sponsor shortfall when locked', () => {
    const reason = publishLockReasonFor({
      isActive: false, gracePeriodEndsAt: null, sponsorsNeeded: 3,
    })
    expect(reason).toContain('locked')
    expect(reason).toContain('3 more sponsors')
  })

  it('says "1 more sponsor", not "1 more sponsors"', () => {
    const reason = publishLockReasonFor({
      isActive: false, gracePeriodEndsAt: null, sponsorsNeeded: 1,
    })
    expect(reason).toContain('1 more sponsor ')
    expect(reason).not.toContain('sponsors')
  })

  it('prefers the grace-period deadline over the generic sponsor count', () => {
    // A PM inside the grace period has a DATE to act by, which is the
    // actionable fact. Telling them to "add 1 more sponsor" with no deadline
    // loses the only part that is urgent.
    const reason = publishLockReasonFor({
      isActive: false, gracePeriodEndsAt: '2026-09-01T00:00:00Z', sponsorsNeeded: 1,
    })
    expect(reason).toContain('paused')
    expect(reason).toContain(new Date('2026-09-01T00:00:00Z').toLocaleDateString())
    expect(reason).not.toContain('more sponsor')
  })

  it('always explains itself when locked — never an empty or bare string', () => {
    // The whole defect was a lock with no reason attached. Any locked state
    // must produce something a person can act on.
    for (const gracePeriodEndsAt of [null, '2026-09-01T00:00:00Z']) {
      for (const sponsorsNeeded of [0, 1, 2, 3]) {
        const reason = publishLockReasonFor({ isActive: false, gracePeriodEndsAt, sponsorsNeeded })
        expect(reason).not.toBeNull()
        expect(reason!.length).toBeGreaterThan(20)
      }
    }
  })
})
