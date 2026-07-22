import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
}))

import { sendOwnerRezConnectedEmail } from '@/lib/inngest/functions/email-ownerrez-connected'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function connectedEvent(overrides: Partial<{ user_id: string; org_id: string; external_user_id: string }> = {}) {
  return {
    data: {
      user_id:          'user_1',
      org_id:           'org_1',
      external_user_id: 'ext_1',
      ...overrides,
    },
  }
}

describe('sendOwnerRezConnectedEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a green bell notification pointing at the properties page', async () => {
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(sendOwnerRezConnectedEmail, {
      event: connectedEvent({ org_id: 'org_1' }),
      step:  makeStep(),
    })

    expect(createPmNotification).toHaveBeenCalledWith(supabase, {
      orgId:     'org_1',
      type:      'integration_connected',
      title:     'OwnerRez connected',
      subtitle:  'Your properties are syncing now',
      href:      '/properties',
      severity:  'green',
      dedupeKey: 'ownerrez-connected-org_1',
    })
  })

  it('scopes the dedupe key per-org so two different orgs never collide', async () => {
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(sendOwnerRezConnectedEmail, {
      event: connectedEvent({ org_id: 'org_9' }),
      step:  makeStep(),
    })

    expect(createPmNotification).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ dedupeKey: 'ownerrez-connected-org_9' }),
    )
  })

  it('propagates a real notification-write failure instead of swallowing it', async () => {
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(createPmNotification as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to create notification: connection reset'),
    )

    await expect(
      invokeHandler(sendOwnerRezConnectedEmail, {
        event: connectedEvent(),
        step:  makeStep(),
      }),
    ).rejects.toThrow('Failed to create notification: connection reset')
  })
})
