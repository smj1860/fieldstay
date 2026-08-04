import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { platformFeePct, resetPlatformFeeReportingForTest } from '@/lib/stripe/platform-fee'
import { reportError } from '@/lib/observability/report-error'

// STRIPE_PLATFORM_FEE_PCT was parsed inline at two call sites with
// parseFloat(). A malformed value became NaN, which survives the entire path
// without erroring: supabase-js JSON-serializes the RPC argument,
// JSON.stringify(NaN) is null, and complete_work_order_via_token()'s
// COALESCE(p_platform_fee_pct, 0) turns that into a 0% fee on every invoice.
// The COALESCE that stops it crashing is what makes it invisible — the only
// symptom is revenue quietly not being collected.
//
// ENV_SPEC declares this as `percent`, but lib/env.ts is imported only by
// unit/guardrails/env-schema-coverage.test.ts, so nothing executes that schema
// at boot.

const ORIGINAL = process.env.STRIPE_PLATFORM_FEE_PCT

describe('platformFeePct', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPlatformFeeReportingForTest()
  })

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.STRIPE_PLATFORM_FEE_PCT
    else process.env.STRIPE_PLATFORM_FEE_PCT = ORIGINAL
  })

  it('returns a fraction, not a percentage', () => {
    process.env.STRIPE_PLATFORM_FEE_PCT = '3'
    expect(platformFeePct()).toBeCloseTo(0.03)
  })

  it('defaults to 0 when unset, without reporting', () => {
    delete process.env.STRIPE_PLATFORM_FEE_PCT
    expect(platformFeePct()).toBe(0)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('treats an empty value as no fee, the same as unset', () => {
    // Number('') is 0, so this is a real zero rather than a malformed value —
    // and it is already an improvement on parseFloat(''), which is NaN and
    // used to reach the RPC as a JSON null.
    process.env.STRIPE_PLATFORM_FEE_PCT = ''
    expect(platformFeePct()).toBe(0)
    expect(reportError).not.toHaveBeenCalled()
  })

  it.each([
    ['three', 'non-numeric'],
    ['3%',    'parseFloat would have silently truncated this to 3'],
    ['-1',    'negative'],
    ['101',   'above 100%'],
  ])('reports and returns 0 for %s (%s)', (raw) => {
    process.env.STRIPE_PLATFORM_FEE_PCT = raw

    expect(platformFeePct()).toBe(0)
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'lib.stripe.platform-fee.invalid' }),
    )
  })

  it('reports once per process, not once per call', () => {
    process.env.STRIPE_PLATFORM_FEE_PCT = 'garbage'

    platformFeePct()
    platformFeePct()
    platformFeePct()

    expect(reportError).toHaveBeenCalledTimes(1)
  })

  it('accepts the boundaries', () => {
    process.env.STRIPE_PLATFORM_FEE_PCT = '0'
    expect(platformFeePct()).toBe(0)
    expect(reportError).not.toHaveBeenCalled()

    process.env.STRIPE_PLATFORM_FEE_PCT = '100'
    expect(platformFeePct()).toBe(1)
    expect(reportError).not.toHaveBeenCalled()
  })
})
