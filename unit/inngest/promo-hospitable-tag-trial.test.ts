import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { NonRetriableError } from 'inngest'
import { tagHospitableTrialSignup } from '@/lib/inngest/functions/promo-hospitable-tag-trial'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

function makeSupabase(rpcResult: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn(() => Promise.resolve(rpcResult))
  return { rpc }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('tagHospitableTrialSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tags the org via tag_hospitable_trial_signup, passing through the landing-page cookie flag', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(tagHospitableTrialSignup, {
      event: { data: { org_id: 'org_1', landing_page_cookie_present: true } },
      step:  makeStep(),
    })

    expect(result).toEqual({ org_id: 'org_1' })
    expect(supabase.rpc).toHaveBeenCalledWith('tag_hospitable_trial_signup', {
      p_org_id:                      'org_1',
      p_landing_page_cookie_present: true,
    })
  })

  it('passes landing_page_cookie_present=false through unchanged (manual/marketplace connects)', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(tagHospitableTrialSignup, {
      event: { data: { org_id: 'org_2', landing_page_cookie_present: false } },
      step:  makeStep(),
    })

    expect(supabase.rpc).toHaveBeenCalledWith('tag_hospitable_trial_signup', {
      p_org_id:                      'org_2',
      p_landing_page_cookie_present: false,
    })
  })

  it('throws a NonRetriableError when org_id is missing (bad event payload, retrying would never help)', async () => {
    await expect(
      invokeHandler(tagHospitableTrialSignup, {
        event: { data: { org_id: '', landing_page_cookie_present: false } },
        step:  makeStep(),
      }),
    ).rejects.toBeInstanceOf(NonRetriableError)
  })

  it('throws (so Inngest retries) when the RPC call itself errors', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'connection reset' } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(tagHospitableTrialSignup, {
        event: { data: { org_id: 'org_1', landing_page_cookie_present: false } },
        step:  makeStep(),
      }),
    ).rejects.toThrow('Failed to tag org org_1 for Hospitable promo: connection reset')
  })
})
