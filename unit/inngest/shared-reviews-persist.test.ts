import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// The write half of every provider's reviews sync, extracted from
// hostex/reviews-sync.ts and hostaway/reviews-sync.ts (44 identical lines,
// 31.9% duplicated on the Hostaway file per SonarQube).
//
// Neither provider's reviews-sync had a test, so the behaviour these lines
// carry was uncovered in BOTH copies. That is worth fixing at the same time as
// the duplication: the three things asserted below are each a silent failure
// if they regress, and a shared helper regresses for every provider at once.
// ============================================================================

import {
  persistNormalizedReviews,
  triggerRepuGuardForReviews,
  type PersistableReview,
} from '@/lib/inngest/functions/shared/reviews-persist'

function review(over: Partial<PersistableReview> = {}): PersistableReview {
  return {
    external_id:          'rev_1',
    external_source:      'hostaway',
    property_external_id: '101',
    rating:               5,
    review_text:          'Lovely stay',
    review_date:          '2026-08-01T00:00:00.000Z',
    response_status:      'pending',
    external_url:         null,
    ...over,
  }
}

/** Records the upsert call; `error` drives the failure path. */
function makeSupabase(error: { message: string } | null = null) {
  const upsert = vi.fn().mockResolvedValue({ error })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: vi.fn(() => ({ upsert })), upsert } as any
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const BASE = {
  orgId:  'org_1',
  userId: 'user_1',
  label:  'Hostaway',
  resolveGuestName: () => 'Jane Guest',
}

beforeEach(() => vi.clearAllMocks())

describe('persistNormalizedReviews', () => {
  it('upserts on (org_id, external_id, external_source) and UPDATES on conflict', async () => {
    // ignoreDuplicates:false is the load-bearing half. Reviews are re-read on
    // every reconcile sweep, and an UPDATE is how a reply posted inside the
    // provider flips response_status locally. With ignoreDuplicates:true the
    // re-read would be a no-op and replies would silently never be noticed.
    const supabase = makeSupabase()

    await persistNormalizedReviews({
      ...BASE, supabase, logger: makeLogger(),
      propertyIdMap: { '101': 'prop_uuid' },
      normalized:    [review()],
    })

    expect(supabase.from).toHaveBeenCalledWith('reviews')
    expect(supabase.upsert.mock.calls[0][1]).toEqual({
      onConflict: 'org_id,external_id,external_source',
      ignoreDuplicates: false,
    })
  })

  it('resolves property_id through the map and guest_name through the hook', async () => {
    // The hook exists because Hostaway carries the guest name on the review and
    // Hostex has to join it out of `bookings`. Asserting it is CALLED with the
    // resolved propertyId is what keeps the Hostex join keyable.
    const supabase = makeSupabase()
    const resolveGuestName = vi.fn().mockReturnValue('Joined Name')

    await persistNormalizedReviews({
      ...BASE, supabase, logger: makeLogger(), resolveGuestName,
      propertyIdMap: { '101': 'prop_uuid' },
      normalized:    [review()],
    })

    expect(resolveGuestName).toHaveBeenCalledWith(expect.objectContaining({ external_id: 'rev_1' }), 'prop_uuid')
    expect(supabase.upsert.mock.calls[0][0][0]).toMatchObject({
      org_id: 'org_1', property_id: 'prop_uuid', guest_name: 'Joined Name',
    })
  })

  it('skips an unmapped property LOUDLY rather than writing a free-floating review', async () => {
    // reviews.property_id is nullable, so an unmapped review WOULD insert —
    // and then be invisible in a UI that lists per property. Dropped, and
    // warned about, so the missing property import is discoverable.
    const supabase = makeSupabase()
    const logger   = makeLogger()

    const count = await persistNormalizedReviews({
      ...BASE, supabase, logger,
      propertyIdMap: { '101': 'prop_uuid' },
      normalized:    [review(), review({ external_id: 'rev_2', property_external_id: '999' })],
    })

    expect(count).toBe(1)
    expect(supabase.upsert.mock.calls[0][0]).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('999'))
  })

  it('does not call the database when every review is unmapped', async () => {
    const supabase = makeSupabase()

    const count = await persistNormalizedReviews({
      ...BASE, supabase, logger: makeLogger(),
      propertyIdMap: { '101': 'prop_uuid' },
      normalized:    [review({ property_external_id: '999' })],
    })

    expect(count).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('THROWS on an upsert error rather than reporting a successful sync', async () => {
    // A swallowed failure here is a provider whose reviews silently never
    // arrive while the connection reports healthy.
    const logger = makeLogger()

    await expect(persistNormalizedReviews({
      ...BASE, supabase: makeSupabase({ message: 'deadlock detected' }), logger,
      propertyIdMap: { '101': 'prop_uuid' },
      normalized:    [review()],
    })).rejects.toThrow(/deadlock detected/)

    expect(logger.error).toHaveBeenCalled()
  })
})

describe('triggerRepuGuardForReviews', () => {
  const step = () => ({ sendEvent: vi.fn(), run: vi.fn(), sleep: vi.fn() })

  it('fires batch generation when reviews were written', async () => {
    // Hostex shipped WITHOUT this: reviews landed in the table and stopped
    // there, and RepuGuard silently did nothing for a whole provider.
    const s = step()

    await triggerRepuGuardForReviews({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      step: s as any, stepId: 'reconcile-trigger-repuguard',
      orgId: 'org_1', requestedBy: 'hostaway-reconcile', reviewCount: 3,
    })

    expect(s.sendEvent).toHaveBeenCalledWith('reconcile-trigger-repuguard', {
      name: 'repuguard/batch_generate.requested',
      data: { org_id: 'org_1', requested_by: 'hostaway-reconcile' },
    })
  })

  it('stays silent when nothing was written', async () => {
    const s = step()

    await triggerRepuGuardForReviews({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      step: s as any, stepId: 'x', orgId: 'org_1', requestedBy: 'hostex-initial', reviewCount: 0,
    })

    expect(s.sendEvent).not.toHaveBeenCalled()
  })
})
