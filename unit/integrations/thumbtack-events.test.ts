import { describe, it, expect } from 'vitest'
import { isThumbtackRfEvent, resolveThumbtackMessage } from '@/lib/integrations/thumbtack-events'

const EXPECTED_ORIGIN = 'https://staging-partner.thumbtack.com'

describe('isThumbtackRfEvent', () => {
  it('accepts every documented Request Flow event shape', () => {
    expect(isThumbtackRfEvent({ type: 'THUMBTACK_RF_CLOSE' })).toBe(true)
    expect(isThumbtackRfEvent({
      type: 'THUMBTACK_RF_START',
      data: { category_pk: 'c', zip_code: '90210', business_pk: 'b', business_name: 'Acme' },
    })).toBe(true)
    expect(isThumbtackRfEvent({
      type: 'THUMBTACK_RF_REQUEST_CREATED',
      data: {
        businesses_contacted: [{ business_pk: 'b', business_name: 'Acme' }],
        category_pk: 'c', zip_code: '90210', user_pk: 'u',
        created_at: 0, is_existing_user: false, search_id: 's', request_pk: 'r',
      },
    })).toBe(true)
  })

  it('rejects a bare string — the exact shape Thumbtack\'s own sample code checks against', () => {
    expect(isThumbtackRfEvent('THUMBTACK_RF_CLOSE')).toBe(false)
  })

  it('rejects null, undefined, and non-Thumbtack objects', () => {
    expect(isThumbtackRfEvent(null)).toBe(false)
    expect(isThumbtackRfEvent(undefined)).toBe(false)
    expect(isThumbtackRfEvent({ type: 'SOME_OTHER_WIDGET_EVENT' })).toBe(false)
    expect(isThumbtackRfEvent({ foo: 'bar' })).toBe(false)
  })
})

describe('resolveThumbtackMessage', () => {
  it('resolves a well-formed event from the expected origin', () => {
    const resolved = resolveThumbtackMessage(
      { origin: EXPECTED_ORIGIN, data: { type: 'THUMBTACK_RF_CLOSE' } },
      EXPECTED_ORIGIN,
    )
    expect(resolved).toEqual({ type: 'THUMBTACK_RF_CLOSE' })
  })

  it('rejects a well-formed event from the WRONG origin — the check the docs\' own sample code skips', () => {
    const resolved = resolveThumbtackMessage(
      { origin: 'https://evil.example.com', data: { type: 'THUMBTACK_RF_CLOSE' } },
      EXPECTED_ORIGIN,
    )
    expect(resolved).toBeNull()
  })

  it('rejects a same-origin message with an unrelated shape', () => {
    const resolved = resolveThumbtackMessage(
      { origin: EXPECTED_ORIGIN, data: { some: 'unrelated payload' } },
      EXPECTED_ORIGIN,
    )
    expect(resolved).toBeNull()
  })
})
