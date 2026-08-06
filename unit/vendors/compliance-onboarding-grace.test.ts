import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { isVendorHardBlocked, VendorComplianceCheckError } from '@/lib/vendors/compliance'
import { isBlockingComplianceStatus } from '@/lib/vendors/compliance-status'
import { reportError } from '@/lib/observability/report-error'

// ============================================================================
// A brand-new org must not be compliance-blocked before it has had a chance to
// collect any documents.
//
// A PM who signs up on Tuesday and bulk-uploads the COIs they already hold
// will have several that are lapsed — precisely BECAUSE they have not chased a
// renewal yet. Under the document rule alone (expired 46+ days ⇒ hard_blocked)
// the first thing FieldStay does for that account is refuse to let them
// dispatch anybody.
//
// The window is a fact on the view (org_onboarding_grace, 60 days from
// organizations.created_at) rather than a state folded into compliance_status,
// so the notification bell and the vendor badge still report the document as
// expired. The PM is TOLD; they are just not BLOCKED. These tests pin both
// halves of that.
// ============================================================================

function clientReturning(row: unknown, error: unknown = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: row, error }))
  return { from: vi.fn(() => chain) }
}

const VENDOR = 'ven_1'
const ORG    = 'org_1'

describe('vendor compliance — new-account onboarding grace', () => {
  beforeEach(() => vi.clearAllMocks())

  it('blocks a hard-blocked vendor in an ESTABLISHED org', async () => {
    const supabase = clientReturning({ compliance_status: 'hard_blocked', org_onboarding_grace: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(isVendorHardBlocked(supabase as any, VENDOR, ORG)).resolves.toBe(true)
  })

  it('does NOT block the same vendor while the org is inside its onboarding window', async () => {
    const supabase = clientReturning({ compliance_status: 'hard_blocked', org_onboarding_grace: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(isVendorHardBlocked(supabase as any, VENDOR, ORG)).resolves.toBe(false)
  })

  // The whole reason the grace is a SEPARATE column rather than a
  // compliance_status value: lib/notifications.ts filters the bell on
  // compliance_status IN ('hard_blocked','expiring_soon','grace_period').
  // Folding the org's age into that column would drop a genuinely expired COI
  // out of the bell and tell a new PM nothing is wrong.
  it('leaves compliance_status alone, so the expired document is still reported', async () => {
    const row = { compliance_status: 'hard_blocked', org_onboarding_grace: true }
    const supabase = clientReturning(row)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await isVendorHardBlocked(supabase as any, VENDOR, ORG)

    // The status the bell and the badge read is untouched by the grace.
    expect(row.compliance_status).toBe('hard_blocked')
  })

  // Grace suspends BLOCKING. It must not suspend the two fail-closed rules
  // that exist because "we could not establish the state" is never "allowed".
  it('still throws when the compliance read itself fails, grace or not', async () => {
    const supabase = clientReturning(null, { code: '42501', message: 'permission denied' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(isVendorHardBlocked(supabase as any, VENDOR, ORG))
      .rejects.toBeInstanceOf(VendorComplianceCheckError)
  })

  it('still blocks when the vendor has no row in the view at all', async () => {
    // No row means the vendor is not in this org — there is no org whose
    // grace could apply, and the grace column cannot be read either.
    const supabase = clientReturning(null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(isVendorHardBlocked(supabase as any, VENDOR, ORG)).resolves.toBe(true)
  })

  // The view is security_invoker and joins organizations under the caller's
  // RLS, so org_onboarding_grace can legitimately arrive absent. Absent must
  // mean "no grace" — the pre-existing behaviour — never "grace".
  it.each([
    ['false',     false],
    ['null',      null],
    ['undefined', undefined],
  ])('treats org_onboarding_grace = %s as NOT in grace', async (_label, value) => {
    const supabase = clientReturning({ compliance_status: 'hard_blocked', org_onboarding_grace: value })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(isVendorHardBlocked(supabase as any, VENDOR, ORG)).resolves.toBe(true)
  })

  // A young org should not generate Sentry noise for a state that was never
  // going to block it — the grace check sits ahead of the unknown-status report.
  it('does not report an unrecognized status while in grace', async () => {
    const supabase = clientReturning({ compliance_status: 'some_future_state', org_onboarding_grace: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(isVendorHardBlocked(supabase as any, VENDOR, ORG)).resolves.toBe(false)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('still reports an unrecognized status for an established org', async () => {
    const supabase = clientReturning({ compliance_status: 'some_future_state', org_onboarding_grace: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(isVendorHardBlocked(supabase as any, VENDOR, ORG)).resolves.toBe(true)
    expect(reportError).toHaveBeenCalled()
  })
})

// The client-side courtesy disable shares the server's allowlist precisely so
// the two cannot disagree. The grace has to reach it for the same reason: an
// <option> greyed out here that the server would have allowed is a vendor the
// PM cannot pick for no visible reason.
describe('isBlockingComplianceStatus — grace parity with the server gate', () => {
  it('blocks hard_blocked without grace', () => {
    expect(isBlockingComplianceStatus('hard_blocked')).toBe(true)
    expect(isBlockingComplianceStatus('hard_blocked', false)).toBe(true)
  })

  it('does not block hard_blocked while in grace', () => {
    expect(isBlockingComplianceStatus('hard_blocked', true)).toBe(false)
  })

  it('keeps treating an absent status as non-blocking (props still loading)', () => {
    expect(isBlockingComplianceStatus(null)).toBe(false)
    expect(isBlockingComplianceStatus(undefined, true)).toBe(false)
  })

  it('agrees with the server on every non-blocking status, grace or not', () => {
    for (const status of ['compliant', 'expiring_soon', 'grace_period', 'no_documents']) {
      expect(isBlockingComplianceStatus(status)).toBe(false)
      expect(isBlockingComplianceStatus(status, true)).toBe(false)
    }
  })
})
