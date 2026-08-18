import { describe, it, expect, vi, beforeEach } from 'vitest'

// handleWebhookEvent dynamically imports both of these — vi.mock intercepts
// dynamic imports the same as static ones.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))

import { ownerRezProvider } from '@/lib/integrations/providers/ownerrez'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

function makeSupabase(connectionRow: { user_id: string; org_id: string } | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select      = vi.fn(() => chain)
  chain.eq          = vi.fn(() => chain)
  // `.in` is here because the status filter is `.in('status',
  // SYNCABLE_CONNECTION_STATUSES)`, not `.eq('status','active')`. An errored
  // connection is exactly the one a webhook should be able to wake; narrowing
  // to 'active' sent it to the full platform sweep, which had the same gate.
  chain.in          = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: connectionRow, error: null }))
  return { from: vi.fn(() => chain), __chain: chain }
}

describe('ownerRezProvider.handleWebhookEvent — connection scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves the connection from externalUserId and includes user_id/org_id on the fired sync-requested event', async () => {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ user_id: 'user_1', org_id: 'org_1' })
    )

    await ownerRezProvider.handleWebhookEvent({
      action:         'entity_update',
      payload:        { entity_type: 'booking', entity_id: '555', user_id: '9001' },
      externalUserId: '9001',
      correlationId:  'corr_1',
    })

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'integration/ownerrez.sync.requested',
      data: expect.objectContaining({
        entity_type: 'booking',
        entity_id:   '555',
        user_id:     'user_1',
        org_id:      'org_1',
      }),
    })
  })

  it('scopes the connection lookup to the SYNCABLE statuses, not active-only', async () => {
    // The webhook must be able to wake an ERRORED connection. Narrowing this to
    // 'active' silently downgraded a scoped sync into a full platform sweep,
    // which carried the identical gate — so the connection was skipped twice
    // and the run still reported success.
    const supabase = makeSupabase({ user_id: 'user_1', org_id: 'org_1' })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await ownerRezProvider.handleWebhookEvent({
      action:         'entity_update',
      payload:        { entity_type: 'booking', entity_id: '555', user_id: '9001' },
      externalUserId: '9001',
      correlationId:  'corr_status',
    })

    expect(supabase.__chain.in).toHaveBeenCalledWith(
      'status',
      expect.arrayContaining(['active', 'error']),
    )
    // 'revoked' is genuinely terminal — only a reconnect produces a new token —
    // so it must stay OUT, or the sweep retries something that cannot succeed.
    const statuses = supabase.__chain.in.mock.calls[0][1] as string[]
    expect(statuses).not.toContain('revoked')

    // And no query in this path may re-narrow with an active-only equality.
    expect(supabase.__chain.eq).not.toHaveBeenCalledWith('status', 'active')
  })

  it('omits user_id/org_id when the connection lookup misses, so the sync function falls back to a full sweep', async () => {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase(null))

    await ownerRezProvider.handleWebhookEvent({
      action:         'entity_create',
      payload:        { entity_type: 'guest', entity_id: '42', user_id: '9001' },
      externalUserId: '9001',
      correlationId:  'corr_2',
    })

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'integration/ownerrez.sync.requested',
      data: expect.objectContaining({
        entity_type: 'guest',
        entity_id:   '42',
        user_id:     undefined,
        org_id:      undefined,
      }),
    })
  })

  it('skips the connection lookup entirely when externalUserId is empty', async () => {
    const supabase = makeSupabase(null)
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await ownerRezProvider.handleWebhookEvent({
      action:         'entity_update',
      payload:        { entity_type: 'booking', entity_id: '555' },
      externalUserId: '',
      correlationId:  'corr_3',
    })

    expect(supabase.from).not.toHaveBeenCalled()
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'integration/ownerrez.sync.requested',
      data: expect.objectContaining({ user_id: undefined, org_id: undefined }),
    })
  })

  it('fires a scoped sync when a property is CREATED in OwnerRez — webhook-primary new-property discovery', async () => {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSupabase({ user_id: 'user_1', org_id: 'org_1' })
    )

    await ownerRezProvider.handleWebhookEvent({
      action:         'entity_insert',
      payload:        { entity_type: 'property', entity_id: '10' },
      externalUserId: '9001',
      correlationId:  'corr_4',
    })

    // The scoped sync path always runs the new-property diff, so this event
    // is what makes a just-added OwnerRez property appear without waiting
    // for the daily cron backstop.
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'integration/ownerrez.sync.requested',
      data: expect.objectContaining({
        entity_type: 'property',
        entity_id:   '10',
        user_id:     'user_1',
        org_id:      'org_1',
      }),
    })
  })

  it('does not fire a sync event for a property UPDATE (edits create no sync work)', async () => {
    await ownerRezProvider.handleWebhookEvent({
      action:         'entity_update',
      payload:        { entity_type: 'property', entity_id: '10' },
      externalUserId: '9001',
      correlationId:  'corr_5',
    })

    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('does not fire a sync event for an entity_type with no handler (e.g. inquiry)', async () => {
    await ownerRezProvider.handleWebhookEvent({
      action:         'entity_update',
      payload:        { entity_type: 'inquiry', entity_id: '77' },
      externalUserId: '9001',
      correlationId:  'corr_6',
    })

    expect(inngest.send).not.toHaveBeenCalled()
  })
})
