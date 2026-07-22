import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
}))

import { notifyIntegrationError } from '@/lib/inngest/functions/notify-integration-error'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function connectionErrorEvent(overrides: Partial<{ org_id: string; provider_id: string; reason: string }> = {}) {
  return {
    data: {
      org_id:      'org_1',
      provider_id: 'kroger',
      reason:      'Access token could not be refreshed',
      ...overrides,
    },
  }
}

describe('notifyIntegrationError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a bell notification with the friendly provider display name', async () => {
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyIntegrationError, {
      event: connectionErrorEvent({ provider_id: 'kroger', reason: 'Refresh token revoked' }),
      step:  makeStep(),
    })

    expect(result).toEqual({ notified: true, org_id: 'org_1', provider_id: 'kroger' })
    expect(createPmNotification).toHaveBeenCalledWith(supabase, {
      orgId:     'org_1',
      type:      'integration_connection_error',
      title:     'Kroger connection needs attention',
      subtitle:  'Refresh token revoked',
      href:      '/settings/integrations',
      severity:  'red',
      dedupeKey: expect.stringMatching(/^integration-error-org_1-kroger-\d{4}-\d{2}-\d{2}$/) as unknown as string,
    })
  })

  it('falls back to the raw provider_id as the display name for an unmapped provider', async () => {
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyIntegrationError, {
      event: connectionErrorEvent({ provider_id: 'some_new_provider', reason: 'Connection lost' }),
      step:  makeStep(),
    })

    expect(result).toEqual({ notified: true, org_id: 'org_1', provider_id: 'some_new_provider' })
    expect(createPmNotification).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ title: 'some_new_provider connection needs attention' }),
    )
  })

  it('recognizes every mapped provider display name', async () => {
    const supabase = {}
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const cases: [string, string][] = [
      ['ownerrez',   'OwnerRez'],
      ['kroger',     'Kroger'],
      ['hostaway',   'Hostaway'],
      ['hospitable', 'Hospitable'],
      ['ical',       'iCal'],
    ]

    for (const [providerId, displayName] of cases) {
      ;(createPmNotification as ReturnType<typeof vi.fn>).mockClear()

      await invokeHandler(notifyIntegrationError, {
        event: connectionErrorEvent({ provider_id: providerId }),
        step:  makeStep(),
      })

      expect(createPmNotification).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({ title: `${displayName} connection needs attention` }),
      )
    }
  })

  describe('dedupe-key date suffix', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T23:59:00.000Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('uses today\'s UTC date (YYYY-MM-DD) so a repeat error the same day dedupes', async () => {
      const supabase = {}
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(notifyIntegrationError, {
        event: connectionErrorEvent({ org_id: 'org_9', provider_id: 'hospitable' }),
        step:  makeStep(),
      })

      expect(createPmNotification).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({ dedupeKey: 'integration-error-org_9-hospitable-2026-07-22' }),
      )
    })
  })
})
