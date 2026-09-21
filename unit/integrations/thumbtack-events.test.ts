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

  it('rejects a type that merely starts with the prefix but is not one of the three documented events', () => {
    // The old check was `.startsWith('THUMBTACK_RF_')`, which would have
    // accepted this as a real event and let it through with `data`
    // completely unvalidated.
    expect(isThumbtackRfEvent({ type: 'THUMBTACK_RF_SOMETHING_NEW', data: {} })).toBe(false)
  })

  describe('rejects a REQUEST_CREATED event whose data does not match the shape', () => {
    // recordThumbtackRequestCreatedAction (lib/integrations/thumbtack-actions.ts)
    // reads event.businesses_contacted.map(...) and several other fields
    // directly off this payload — a same-origin but malformed message used
    // to pass this guard on the type string alone and could crash that
    // Server Action.
    it('with no data at all', () => {
      expect(isThumbtackRfEvent({ type: 'THUMBTACK_RF_REQUEST_CREATED' })).toBe(false)
    })

    it('with data missing businesses_contacted', () => {
      expect(isThumbtackRfEvent({
        type: 'THUMBTACK_RF_REQUEST_CREATED',
        data: { category_pk: 'c', zip_code: '90210', user_pk: 'u', created_at: 0, is_existing_user: false, search_id: 's', request_pk: 'r' },
      })).toBe(false)
    })

    it('with businesses_contacted holding a malformed entry', () => {
      expect(isThumbtackRfEvent({
        type: 'THUMBTACK_RF_REQUEST_CREATED',
        data: {
          businesses_contacted: [{ business_pk: 'b' }],   // missing business_name
          category_pk: 'c', zip_code: '90210', user_pk: 'u',
          created_at: 0, is_existing_user: false, search_id: 's', request_pk: 'r',
        },
      })).toBe(false)
    })

    it('with the wrong type for a field (created_at as a string)', () => {
      expect(isThumbtackRfEvent({
        type: 'THUMBTACK_RF_REQUEST_CREATED',
        data: {
          businesses_contacted: [{ business_pk: 'b', business_name: 'Acme' }],
          category_pk: 'c', zip_code: '90210', user_pk: 'u',
          created_at: '0', is_existing_user: false, search_id: 's', request_pk: 'r',
        },
      })).toBe(false)
    })

    it('with data as null', () => {
      expect(isThumbtackRfEvent({ type: 'THUMBTACK_RF_REQUEST_CREATED', data: null })).toBe(false)
    })
  })

  describe('rejects a START event whose data does not match the shape', () => {
    it('with a missing field', () => {
      expect(isThumbtackRfEvent({
        type: 'THUMBTACK_RF_START',
        data: { category_pk: 'c', zip_code: '90210', business_pk: 'b' },   // missing business_name
      })).toBe(false)
    })

    it('with no data at all', () => {
      expect(isThumbtackRfEvent({ type: 'THUMBTACK_RF_START' })).toBe(false)
    })
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
