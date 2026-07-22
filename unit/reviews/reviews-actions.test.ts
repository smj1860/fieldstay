import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import {
  requestBatchGeneration,
  submitManualReview,
  getManualReviewsUsedThisWeek,
} from '@/app/(dashboard)/reviews/actions'

type Resp = { data?: unknown; error?: unknown; count?: number }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null, count: 0 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'eq', 'gte']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('reviews/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('requestBatchGeneration', () => {
    it('sends the batch-generate event when RepuGuard is active for the org', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { repuguard_status: 'active' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await requestBatchGeneration()

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'repuguard/batch_generate.requested',
        data: { org_id: 'org_1', requested_by: 'user_1' },
      })
    })

    it('refuses when RepuGuard is not enabled for the org', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { repuguard_status: 'inactive' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await requestBatchGeneration()

      expect(result).toEqual({ success: false, error: 'RepuGuard is not enabled for this account.' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await requestBatchGeneration()

      expect(result).toEqual({ success: false, error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('submitManualReview', () => {
    const validInput = {
      reviewText: 'Great stay, would come back',
      starRating: 5,
      guestName:  'Jane Guest',
      propertyId: 'prop_1',
      platform:   'airbnb',
    }

    it('inserts a manual review scoped to the caller org', async () => {
      const supabase = makeSupabase({
        reviews:    [{ count: 0 }, { data: { id: 'review_1' } }],
        properties: [{ data: { id: 'prop_1' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ membership } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitManualReview(validInput)

      expect(result).toEqual({ reviewId: 'review_1' })
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        reviews:    [{ count: 0 }],
        properties: [{ data: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ membership } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitManualReview(validInput)

      expect(result).toEqual({ error: 'Property not found.' })
    })

    it('enforces the weekly manual-review limit', async () => {
      const supabase = makeSupabase({
        reviews: [{ count: 2 }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ membership } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitManualReview(validInput)

      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toMatch(/used both manual reviews/)
    })

    it('rejects an out-of-range star rating before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({ membership } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitManualReview({ ...validInput, starRating: 6 })

      expect(result).toEqual({ error: 'Star rating must be between 1 and 5.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitManualReview(validInput)

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('getManualReviewsUsedThisWeek', () => {
    it('returns the count scoped to the caller org', async () => {
      const supabase = makeSupabase({ reviews: [{ count: 1 }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ membership } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await getManualReviewsUsedThisWeek()

      expect(result).toBe(1)
    })

    it('throws when the caller is not an authenticated org member', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(getManualReviewsUsedThisWeek()).rejects.toThrow('REDIRECT:/login')
    })
  })
})
