import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/unwrap', () => ({
  tryUnwrap: vi.fn((res: { data?: unknown; error?: unknown }) =>
    res.error ? { ok: false as const } : { ok: true as const, data: res.data }),
}))

import { resolveEmailAudience } from '@/lib/email/unsubscribe'

/**
 * CAN-SPAM requires a physical postal address in commercial email, and
 * emails/components/email-layout.tsx renders the opt-out block only when BOTH
 * the unsubscribe URL and the address are present. So an unset
 * COMPANY_POSTAL_ADDRESS drops the address AND the unsubscribe link, producing
 * mail that is non-compliant on both counts while every send still reports
 * success. resolveEmailAudience must suppress rather than let that ship.
 */
function supabaseReturning(profile: unknown) {
  const chain = {
    select:      () => chain,
    eq:          () => chain,
    maybeSingle: () => Promise.resolve({ data: profile, error: null }),
  }
  return { from: () => chain } as never
}

const PROFILE = { email_unsubscribed_at: null, unsubscribe_token: 'tok_abc' }

describe('resolveEmailAudience — COMPANY_POSTAL_ADDRESS gate', () => {
  const original = process.env.COMPANY_POSTAL_ADDRESS

  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => {
    if (original === undefined) delete process.env.COMPANY_POSTAL_ADDRESS
    else process.env.COMPANY_POSTAL_ADDRESS = original
  })

  it('suppresses the send when the postal address is unset', async () => {
    delete process.env.COMPANY_POSTAL_ADDRESS

    const result = await resolveEmailAudience(supabaseReturning(PROFILE), 'user_1')

    expect(result.suppressed).toBe(true)
    expect(result.unsubscribeUrl).toBeNull()
    expect(result.headers).toEqual({})
  })

  it('suppresses when the postal address is only whitespace', async () => {
    process.env.COMPANY_POSTAL_ADDRESS = '   '

    const result = await resolveEmailAudience(supabaseReturning(PROFILE), 'user_1')

    expect(result.suppressed).toBe(true)
  })

  it('allows the send, with opt-out artifacts, once an address is configured', async () => {
    process.env.COMPANY_POSTAL_ADDRESS = '1 Test Way, Testville TS 00000'

    const result = await resolveEmailAudience(supabaseReturning(PROFILE), 'user_1')

    expect(result.suppressed).toBe(false)
    expect(result.unsubscribeUrl).toContain('/unsubscribe/tok_abc')
    expect(result.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('still suppresses an opted-out recipient even with an address configured', async () => {
    process.env.COMPANY_POSTAL_ADDRESS = '1 Test Way, Testville TS 00000'

    const result = await resolveEmailAudience(
      supabaseReturning({ ...PROFILE, email_unsubscribed_at: '2026-01-01T00:00:00Z' }),
      'user_1',
    )

    expect(result.suppressed).toBe(true)
  })
})
