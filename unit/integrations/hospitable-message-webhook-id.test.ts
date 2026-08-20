import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// HOSPITABLE MESSAGE WEBHOOKS ARE STORED FROM THE PAYLOAD, NOT FETCHED.
//
// 2026-08-20, production. Hospitable's partner API log filled with:
//
//   400 GET /v2/reservations/1262483200/messages
//   {"status_code":400,"reason_phrase":"Invalid resource uuid provided."}
//
// The handler resolved its reservation id through a four-step ?? chain:
//
//   entityData.reservation_id ?? entityId ?? data.reservation_id ?? data.id
//
// A real payload captured the same day shows why every part of that was wrong:
//
//   "data": { "id": 1262483200, "reservation_id": null,
//             "conversation_id": "<uuid>", "body": "...", ... }
//
//  1. `data.id` is the MESSAGE's id, and it is NUMERIC. The `as string` cast
//     over a Record<string, unknown> typechecked, and 1262483200 went into a
//     URL path — then retried for 10m41s, twice, against an endpoint capped at
//     2 requests/minute per reservation.
//  2. `reservation_id: null` is CORRECT. That message is a pre-booking
//     inquiry. A design keyed on reservations drops every inquiry forever.
//  3. The payload already contains the WHOLE message, so the fetch was
//     re-requesting data we had been handed.
//
// The fixture below mirrors that payload field for field. Names, emails and
// ids are invented: the real one carries a host's email address and a guest's
// first name, and a regression fixture is not a reason to commit either.
// ============================================================================

const sendMock = vi.fn()
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: sendMock } }))

const reportErrorMock = vi.fn()
vi.mock('@/lib/observability/report-error', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}))

const resolveOrgMock = vi.fn()
vi.mock('@/lib/integrations/providers/hospitable-owner', () => ({
  resolveHospitableOrg:   (...a: unknown[]) => resolveOrgMock(...a),
  resolveHospitableOwner: vi.fn(),
}))

const upsertMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'reservation_messages') {
        return { upsert: (...a: unknown[]) => { upsertMock(...a); return Promise.resolve({ error: null }) } }
      }
      // bookings
      const chain = {
        select:      () => chain,
        eq:          () => chain,
        maybeSingle: () => Promise.resolve({ data: { id: 'booking_1' }, error: null }),
      }
      return chain
    },
  }),
}))

const PROPERTY_UUID     = '2a0edb20-ed19-4c8d-ae6e-18ff0b515e94'
const CONVERSATION_UUID = '52f34b56-cb20-46c5-a224-8dd9d9f5dd19'
const RESERVATION_UUID  = 'db0dca2d-1a35-42fa-84ad-606bb1b0c021'
const HOST_USER_UUID    = '5e87aec9-56bc-4f0f-90c1-31bc369a5269'
const GUEST_TEXT        = 'Hi there, what time is checkout? My flight is at 6.'

/** The real inquiry payload's shape, with invented identities. */
function inquiryPayload(over: Record<string, unknown> = {}) {
  return {
    id:              1262483200,          // NUMERIC, and the message's own id
    body:            GUEST_TEXT,
    user:            { id: HOST_USER_UUID, name: 'Test Host', email: 'host@example.invalid' },
    sender:          { full_name: 'Test Host', first_name: 'Test' },
    source:          'automated',
    listing:         { platform: 'airbnb', platform_id: '1750053371251599183' },
    platform:        'airbnb',
    property:        { id: PROPERTY_UUID, name: 'Test Loft', public_name: 'Test Loft' },
    reactions:       [],
    created_at:      '2026-08-20T05:16:12Z',
    attachments:     [],
    integration:     null,
    platform_id:     '32335537219',
    sender_role:     'host',
    sender_type:     'host',
    content_type:    'text/plain',
    reservation_id:  null,                // the point
    conversation_id: CONVERSATION_UUID,
    ...over,
  }
}

async function fire(data: Record<string, unknown>, action = 'message.created') {
  const { hospitableProvider } = await import('@/lib/integrations/providers/hospitable')
  await hospitableProvider.handleWebhookEvent!({
    action,
    payload: { id: 'a28b8ffd-1a84-487c-92e0-0a161b8b86d1', data, action, version: 'v2', triggers: [] },
  } as Parameters<NonNullable<typeof hospitableProvider.handleWebhookEvent>>[0])
}

const rowFrom = (call: unknown[]) => call[0] as Record<string, unknown>

describe('hospitable message webhook → stored row', () => {
  beforeEach(() => {
    sendMock.mockReset()
    reportErrorMock.mockReset()
    upsertMock.mockReset()
    resolveOrgMock.mockReset().mockResolvedValue({ orgId: 'org_1', userId: 'user_1' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('stores a pre-booking INQUIRY, which the old design could not', async () => {
    await fire(inquiryPayload())

    expect(upsertMock, 'an inquiry has no reservation and must still be stored').toHaveBeenCalledTimes(1)
    const row = rowFrom(upsertMock.mock.calls[0]!)

    expect(row.external_reservation_id, 'reservation_id: null is correct, not a gap').toBeNull()
    expect(row.conversation_id).toBe(CONVERSATION_UUID)
    expect(row.org_id).toBe('org_1')
    expect(row.body).toBe(GUEST_TEXT)
    expect(row.sender_type).toBe('host')
    expect(row.message_created_at).toBe('2026-08-20T05:16:12Z')
  })

  it('NEVER calls Hospitable — the payload is the source', async () => {
    // The single property this whole change exists to establish. A fetch here
    // is the 400, the 2-req/min ceiling, and the 10-minute retry storm.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await fire(inquiryPayload())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sendMock, 'no Inngest hop either — an event carrying `body` would copy every guest message into a third-party queue')
      .not.toHaveBeenCalled()
  })

  it('never treats the numeric message id as a reservation id', async () => {
    await fire(inquiryPayload())
    const row = rowFrom(upsertMock.mock.calls[0]!)

    expect(JSON.stringify(row.external_reservation_id)).not.toContain('1262483200')
    // It becomes the dedup key instead, where a message id belongs.
    expect(row.dedup_key).toBe('hosp:msg:1262483200')
  })

  it('links to the booking when the thread DOES have a reservation', async () => {
    await fire(inquiryPayload({ reservation_id: RESERVATION_UUID }))
    const row = rowFrom(upsertMock.mock.calls[0]!)

    expect(row.external_reservation_id).toBe(RESERVATION_UUID)
    expect(row.booking_id).toBe('booking_1')
  })

  it('ignores a reservation_id that is not a UUID', async () => {
    // Defence in depth against the original defect arriving from a new angle.
    await fire(inquiryPayload({ reservation_id: 1262483200 }))
    const row = rowFrom(upsertMock.mock.calls[0]!)

    expect(row.external_reservation_id).toBeNull()
    expect(row.booking_id).toBeNull()
  })

  it('lets message.updated overwrite its own row', async () => {
    // message.updated carries the same data.id as its message.created, so the
    // edit must land on the same row. ignoreDuplicates: true — what the old
    // path used — would silently discard every edit.
    await fire(inquiryPayload({ body: 'edited' }), 'message.updated')

    expect(upsertMock.mock.calls[0]![1]).toMatchObject({
      onConflict:       'org_id,dedup_key',
      ignoreDuplicates: false,
    })
  })

  it('resolves the org through the shared resolver, keyed on the property', async () => {
    await fire(inquiryPayload())

    expect(resolveOrgMock).toHaveBeenCalledWith({
      entityKind:     'property',
      externalId:     PROPERTY_UUID,
      externalUserId: HOST_USER_UUID,
    })
  })

  it('stores nothing when no connected account owns the property', async () => {
    resolveOrgMock.mockResolvedValue(null)
    await fire(inquiryPayload())

    expect(upsertMock).not.toHaveBeenCalled()
  })
})

describe('hospitable message webhook → unusable payloads', () => {
  beforeEach(() => {
    reportErrorMock.mockReset()
    upsertMock.mockReset()
    resolveOrgMock.mockReset().mockResolvedValue({ orgId: 'org_1', userId: 'user_1' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['no conversation_id', { conversation_id: null }],
    ['no created_at',      { created_at: null }],
    ['no sender_type',     { sender_type: 'neither' }],
    ['no message id',      { id: null }],
  ])('drops and reports: %s', async (_label, over) => {
    await fire(inquiryPayload(over))

    expect(upsertMock).not.toHaveBeenCalled()
    expect(reportErrorMock, 'dropping silently is how the first version of this went unnoticed')
      .toHaveBeenCalledTimes(1)
  })

  it('drops when there is no property to attribute the org from', async () => {
    await fire(inquiryPayload({ property: null }))

    expect(upsertMock).not.toHaveBeenCalled()
    expect(resolveOrgMock, 'must not fall back to picking an active connection').not.toHaveBeenCalled()
    expect(reportErrorMock).toHaveBeenCalledTimes(1)
  })

  it('logs the payload SHAPE and never its content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await fire(inquiryPayload({ conversation_id: null }))

    const logged = JSON.stringify(warn.mock.calls) + JSON.stringify(reportErrorMock.mock.calls)
    expect(logged, 'guest message content must never reach a log').not.toContain(GUEST_TEXT)
    expect(logged).not.toContain('host@example.invalid')
    // Field names ARE logged — that is the diagnostic, and a key is not content.
    expect(logged).toContain('conversation_id')
  })
})

describe('ProviderRequestError is terminal, not retried', () => {
  it('is distinct from ProviderAuthError — the connection is healthy', async () => {
    const { ProviderRequestError, ProviderAuthError } = await import('@/lib/integrations/types')
    const err = new ProviderRequestError('Hospitable', 400, 'GET /x')

    expect(err).not.toBeInstanceOf(ProviderAuthError)
    expect(err.name).toBe('ProviderRequestError')
    // The message is what a responder reads in Sentry. It must not send them
    // to the OAuth connection for a bug in our own request construction.
    expect(err.message).not.toMatch(/reconnect/i)
    expect(err.message).toMatch(/retrying sends the same request/)
  })

  it('the sync function converts it to NonRetriableError', async () => {
    // Asserted against the source rather than by driving Inngest's runtime:
    // the property that matters is that the ProviderAuthError branch and this
    // one stay together, and a future edit that removes one is visible here.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/inngest/functions/hospitable/incremental-sync.ts', 'utf8')
    expect(src).toMatch(/err instanceof ProviderRequestError\) throw new NonRetriableError/)
    expect(src).toMatch(/err instanceof ProviderAuthError\)\s+throw new NonRetriableError/)
  })
})
