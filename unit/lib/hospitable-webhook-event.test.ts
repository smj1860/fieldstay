import { describe, it, expect, vi, beforeEach } from 'vitest'

// BLOCKER-6: reservation.changed sends a PARTIAL payload with no id
// anywhere that identifies the reservation once data.data has no `id`
// field (e.g. a checkin-time-only change). The old code fell back to the
// top-level payload.id, which is the webhook DELIVERY's own id, not the
// reservation's — that produced a 404 on the subsequent GET, which
// incremental-sync.ts's missing-reservation branch silently treated as a
// real cancellation, discarding the actual update. These tests prove the
// fallback is gone and an unresolvable payload is dropped loudly instead.
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

const sendMock = vi.fn()
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => sendMock(...args) },
}))

import { hospitableProvider } from '@/lib/integrations/providers/hospitable'
import { reportError } from '@/lib/observability/report-error'

describe('hospitableProvider.handleWebhookEvent — reservation id resolution (BLOCKER-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves reservation.created from data.data.id and fires sync.requested', async () => {
    await hospitableProvider.handleWebhookEvent({
      action:  'reservation.created',
      externalUserId: '',
      payload: {
        id:      'delivery_abc',
        action:  'reservation.created',
        data:    { id: 'res_real_id', check_in: '2026-08-01' },
      },
    })

    expect(sendMock).toHaveBeenCalledWith({
      name: 'integration/hospitable.sync.requested',
      data: expect.objectContaining({
        entity_type: 'reservation',
        entity_id:   'res_real_id',
      }),
    })
  })

  it('resolves a FULL reservation.changed payload (data.data.id present) normally', async () => {
    await hospitableProvider.handleWebhookEvent({
      action:  'reservation.changed',
      externalUserId: '',
      payload: {
        id:      'delivery_xyz',
        action:  'reservation.changed',
        data:    { id: 'res_real_id_2', status: 'confirmed' },
        triggers: ['financials_changed'],
      },
    })

    expect(sendMock).toHaveBeenCalledWith({
      name: 'integration/hospitable.sync.requested',
      data: expect.objectContaining({ entity_id: 'res_real_id_2' }),
    })
  })

  it('drops a PARTIAL reservation.changed payload (no data.data.id) instead of falling back to the top-level delivery id', async () => {
    await hospitableProvider.handleWebhookEvent({
      action:  'reservation.changed',
      externalUserId: '',
      payload: {
        id:       'delivery_only_id_never_the_reservation',
        action:   'reservation.changed',
        data:     { check_in: '2026-08-02T16:00:00Z' },
        triggers: ['checkin_changed'],
      },
    })

    // Must NOT send a sync event using the top-level delivery id.
    expect(sendMock).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        site:  'lib.integrations.providers.hospitable.handleWebhookEvent',
        extra: { action: 'reservation.changed' },
      }),
    )
  })

  it('threads external_user_id (data.user.id) through when present on a reservation event', async () => {
    await hospitableProvider.handleWebhookEvent({
      action:  'reservation.created',
      externalUserId: '',
      payload: {
        id:     'delivery_1',
        action: 'reservation.created',
        data:   { id: 'res_1', user: { id: 'hosp_user_42', name: 'Costin Soare' } },
      },
    })

    expect(sendMock).toHaveBeenCalledWith({
      name: 'integration/hospitable.sync.requested',
      data: expect.objectContaining({ external_user_id: 'hosp_user_42' }),
    })
  })
})
