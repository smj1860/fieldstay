import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmMembers:         vi.fn(async () => []),
  getPmMembersByOrgIds: vi.fn(async () => new Map()),
}))

import { staleFeedAlert } from '@/lib/inngest/functions/cron/stale-feed-alert'
import { createServiceClient } from '@/lib/supabase/server'
import { getPmMembers, getPmMembersByOrgIds } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

function makeSupabase(responses: Record<string, TableSpec>) {
  return createSupabaseDouble(responses)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

describe('staleFeedAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when there are no stale iCal feeds', async () => {
    const supabase = makeSupabase({ ical_feeds: { data: [], error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(staleFeedAlert, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ alerted: 0 })
    expect(getPmMembers).not.toHaveBeenCalled()
  })

  it('groups stale feeds by org and batches one integration/connection.error event per org with a PM into a single sendEvent', async () => {
    const supabase = makeSupabase({
      ical_feeds: {
        data: [
          { id: 'feed_1', name: 'Airbnb', org_id: 'org_1', last_synced_at: null, properties: { name: 'Cabin A' } },
          { id: 'feed_2', name: 'VRBO', org_id: 'org_1', last_synced_at: '2026-07-20T00:00:00.000Z', properties: { name: 'Cabin B' } },
          { id: 'feed_3', name: 'Direct', org_id: 'org_2', last_synced_at: null, properties: { name: 'Lodge' } },
        ],
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    // The PM per org comes from ONE batched getPmMembersByOrgIds() call for
    // every org at once — the helper owns the owner-before-admin ordering and
    // the invite_accepted_at filter, which this cron used to re-derive inline.
    // org_2 deliberately has no entry — it must be skipped, not crash.
    ;(getPmMembersByOrgIds as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([['org_1', [{ userId: 'user_1', email: 'pm@x.com', role: 'owner' }]]]),
    )

    const step = makeStep()
    const result = await invokeHandler(staleFeedAlert, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ alerted: 1 })
    // ONE batched sendEvent carrying an event array — not one step.sendEvent
    // per org, which put the whole platform's org count into a single run's
    // step budget.
    expect(step.sendEvent).toHaveBeenCalledTimes(1)
    expect(step.sendEvent).toHaveBeenCalledWith(
      'notify-stale-feeds',
      [
        expect.objectContaining({
          name: 'integration/connection.error',
          data: expect.objectContaining({
            user_id:     'user_1',
            org_id:      'org_1',
            provider_id: 'ical',
            reason:      "2 feeds haven't synced in 6+ hours",
          }),
        }),
      ],
    )
    // The per-org GoTrue-hitting helper is no longer on this path at all.
    expect(getPmMembers).not.toHaveBeenCalled()
  })

  it('uses singular "feed" wording when only one feed is stale for an org', async () => {
    const supabase = makeSupabase({
      ical_feeds: {
        data: [
          { id: 'feed_1', name: 'Airbnb', org_id: 'org_1', last_synced_at: null, properties: { name: 'Cabin A' } },
        ],
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmMembersByOrgIds as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([['org_1', [{ userId: 'user_1', email: 'pm@x.com', role: 'owner' }]]]),
    )

    const step = makeStep()
    await invokeHandler(staleFeedAlert, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(step.sendEvent).toHaveBeenCalledWith(
      'notify-stale-feeds',
      [
        expect.objectContaining({
          // NOTE: the source hardcodes "haven't" regardless of feedCount (only
          // "feed"/"feeds" is pluralized) — grammatically "1 feed haven't
          // synced" is off, but this asserts actual current behavior.
          data: expect.objectContaining({ reason: "1 feed haven't synced in 6+ hours" }),
        }),
      ],
    )
  })
})
