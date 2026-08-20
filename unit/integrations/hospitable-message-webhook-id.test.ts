import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// A HOSPITABLE ENTITY ID IS A UUID OR IT IS NOT DISPATCHED.
//
// 2026-08-20, production. Hospitable's partner API log filled with:
//
//   400 GET /v2/reservations/1262483200/messages
//   400 GET /v2/reservations/1262483160/messages
//   {"status_code":400,"reason_phrase":"Invalid resource uuid provided."}
//
// The message.created webhook handler resolved its reservation id through a
// four-step ?? chain:
//
//   entityData.reservation_id ?? entityId ?? data.reservation_id ?? data.id
//
// Only the first and third name a reservation. `entityId` is data.data.id —
// the MESSAGE's own id — and `data.id` is the webhook DELIVERY's id, which the
// reservation.changed branch in the same switch already documents as such.
// Both were cast `as string | undefined` over a `Record<string, unknown>`, so
// a numeric platform id typechecked cleanly and went into a URL path.
//
// The cost was not one 400. It was, per event:
//   - 5 Inngest retries x 2 withProviderCall attempts, all against an API
//     Hospitable rate-limits to 2 req/min per reservation;
//   - 10m41s holding one of the function's 8 concurrency slots, twice
//     concurrently, while every other Hospitable webhook queued behind them;
//   - a row written into integration_entity_owners CACHING the bogus id as a
//     real reservation, because resolveHospitableOwner's step-0 attribution
//     calls rememberOwner() before anything validates the id.
//
// Three checks, one per layer, because each catches a different future
// mistake: the dispatcher must not emit it, the function must not act on it,
// and the fetch helper must not build the URL.
// ============================================================================

const sendMock = vi.fn()

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: sendMock } }))

const reportErrorMock = vi.fn()
vi.mock('@/lib/observability/report-error', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}))

const RESERVATION_UUID = 'db0dca2d-1a35-42fa-84ad-606bb1b0c021'

async function fireMessageWebhook(data: Record<string, unknown>) {
  const { hospitableProvider } = await import('@/lib/integrations/providers/hospitable')
  await hospitableProvider.handleWebhookEvent!({
    action:  'message.created',
    payload: { data },
  } as Parameters<NonNullable<typeof hospitableProvider.handleWebhookEvent>>[0])
}

describe('hospitable message webhook — reservation id resolution', () => {
  beforeEach(() => {
    sendMock.mockReset()
    reportErrorMock.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('dispatches when the payload carries a reservation UUID', async () => {
    await fireMessageWebhook({ id: 1262483200, reservation_id: RESERVATION_UUID })

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0]![0].data).toMatchObject({
      entity_type: 'message',
      entity_id:   RESERVATION_UUID,
    })
  })

  it('DROPS a payload whose only id is the numeric platform id — the live 400', async () => {
    // The exact shape observed in production: no reservation_id anywhere, and
    // data.data.id is the platform's own numeric message id.
    await fireMessageWebhook({ id: 1262483200, conversation_id: 'abc', platform: 'airbnb' })

    expect(sendMock, 'a run that cannot succeed must not be enqueued').not.toHaveBeenCalled()
    expect(reportErrorMock, 'dropping silently is how this went unnoticed').toHaveBeenCalledTimes(1)
  })

  it('does not fall back to the webhook delivery id at the payload top level', async () => {
    // data.id is the DELIVERY's id. It is often a UUID, which is what makes
    // this the dangerous fallback: it would have passed a naive shape check and
    // 404'd forever instead of 400ing loudly.
    const { hospitableProvider } = await import('@/lib/integrations/providers/hospitable')
    await hospitableProvider.handleWebhookEvent!({
      action:  'message.created',
      payload: { id: '11111111-2222-3333-4444-555555555555', data: { id: 1262483200 } },
    } as Parameters<NonNullable<typeof hospitableProvider.handleWebhookEvent>>[0])

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('logs the payload SHAPE and never its content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const guestText = 'what time is checkout, my flight is at 6'

    await fireMessageWebhook({ id: 1262483200, body: guestText, sender: { full_name: 'A Guest' } })

    const logged = JSON.stringify(warn.mock.calls) + JSON.stringify(reportErrorMock.mock.calls)
    expect(logged, 'guest message content must never reach a log').not.toContain(guestText)
    expect(logged).not.toContain('A Guest')
    // Field names ARE logged — that is the diagnostic, and a key is not content.
    expect(logged).toContain('conversation_id')
    expect(logged).toContain('absent')
  })
})

describe('hospFetchReservationMessages — refuses to build the URL', () => {
  it('throws ProviderRequestError instead of spending a rate-limit token', async () => {
    const { hospFetchReservationMessages } = await import('@/lib/integrations/providers/hospitable')
    const { ProviderRequestError } = await import('@/lib/integrations/types')

    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(hospFetchReservationMessages('token', '1262483200'))
      .rejects.toBeInstanceOf(ProviderRequestError)

    expect(fetchSpy, 'no HTTP call should be made for an id that cannot be valid').not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('ProviderRequestError is terminal, not retried', () => {
  it('is distinct from ProviderAuthError — the connection is healthy', async () => {
    const { ProviderRequestError, ProviderAuthError } = await import('@/lib/integrations/types')
    const err = new ProviderRequestError('Hospitable', 400, 'GET /x')

    expect(err).not.toBeInstanceOf(ProviderAuthError)
    expect(err.name).toBe('ProviderRequestError')
    // The message is what a responder reads in Sentry. It must not send them
    // to the OAuth connection for a bug in our own URL construction.
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
