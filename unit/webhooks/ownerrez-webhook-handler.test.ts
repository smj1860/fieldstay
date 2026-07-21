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
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: connectionRow, error: null }))
  return { from: vi.fn(() => chain) }
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

  it('does not fire a sync event for an entity_type with no handler yet (e.g. property)', async () => {
    await ownerRezProvider.handleWebhookEvent({
      action:         'entity_update',
      payload:        { entity_type: 'property', entity_id: '10' },
      externalUserId: '9001',
      correlationId:  'corr_4',
    })

    expect(inngest.send).not.toHaveBeenCalled()
  })
})
