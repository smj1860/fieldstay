import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createHash } from 'crypto'
// canonicalJson, not JSON.stringify: the route hashes a key-sorted
// serialization so the dedup key cannot depend on the provider's key order.
import { canonicalJson } from '@/lib/integrations/canonical-json'

// CLAUDE.md's "Dedup" rule: generic provider webhooks must be deduped on a
// content-hash keyed row in `processed_webhooks`, not `payload.id` — see the
// route's own comment block for why (Hospitable's docs contradict themselves
// on whether `id` is per-delivery or per-entity). These tests prove: a retry
// of the exact same payload is discarded as a no-op, two distinct payloads
// are never conflated, and the handler is only ever invoked once per unique
// payload.
vi.mock('@/lib/integrations/registry', () => ({
  getProvider: vi.fn(),
}))
vi.mock('@/lib/integrations/vault', () => ({
  revokeIntegrationToken: vi.fn(),
  findUserByExternalId:   vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { POST } from '@/app/api/webhooks/[provider]/route'
import { getProvider } from '@/lib/integrations/registry'
import { createServiceClient } from '@/lib/supabase/server'

// Stateful fake mirroring the real UNIQUE constraint on processed_webhooks.webhook_id:
// the same webhook_id inserted twice fails the second time with Postgres code 23505.
function makeSupabase() {
  const insertedIds = new Set<string>()
  const rpc = vi.fn(() => Promise.resolve({ error: null }))
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.insert = vi.fn((row: { webhook_id: string }) => {
      if (table !== 'processed_webhooks') return Promise.resolve({ error: null })
      if (insertedIds.has(row.webhook_id)) {
        return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
      }
      insertedIds.add(row.webhook_id)
      return Promise.resolve({ error: null })
    })
    chain.select       = vi.fn(() => chain)
    chain.eq           = vi.fn(() => chain)
    chain.maybeSingle  = vi.fn(() => Promise.resolve({ data: null }))
    return chain
  })
  return { from, rpc, insertedIds }
}

function makeProviderAdapter() {
  return {
    authType:        'apiKey' as const,
    validateWebhook: vi.fn(() => Promise.resolve({ valid: true })),
    handleWebhookEvent: vi.fn(() => Promise.resolve()),
    getApiHeaders: vi.fn(() => ({})),
  }
}

function postRequest(providerId: string, body: unknown) {
  return new NextRequest(`http://localhost/api/webhooks/${providerId}`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

function callPost(providerId: string, body: unknown) {
  return POST(postRequest(providerId, body), { params: Promise.resolve({ provider: providerId }) })
}

describe('POST /api/webhooks/[provider] — content-hash dedup', () => {
  let supabase: ReturnType<typeof makeSupabase>
  let adapter: ReturnType<typeof makeProviderAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = makeSupabase()
    adapter  = makeProviderAdapter()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getProvider as ReturnType<typeof vi.fn>).mockReturnValue(adapter)
  })

  it('derives the dedup key from a sha256 hash of the payload, not payload.id', async () => {
    const payload = { action: 'reservation.changed', id: 'evt_stable_reused_id', reservation_id: 'res_1', created: '2026-07-21T00:00:00Z' }

    await callPost('hospitable', payload)

    const expectedHash = createHash('sha256').update(canonicalJson(payload)).digest('hex')
    expect(supabase.insertedIds.has(`hospitable:${expectedHash}`)).toBe(true)
    expect(adapter.handleWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('dedups a retry whose keys arrive in a different order', async () => {
    // The key used to be JSON.stringify(payload), which emits keys in the
    // parsed object's own order — i.e. the order the PROVIDER serialized them
    // in. A retry re-serialized through a different code path carried the same
    // logical event, hashed differently, and was processed a second time with
    // nothing to show it was a duplicate.
    const first  = JSON.parse('{"action":"reservation.changed","id":"evt_1","data":{"a":1,"b":2}}')
    const second = JSON.parse('{"data":{"b":2,"a":1},"id":"evt_1","action":"reservation.changed"}')

    const res1 = await callPost('hospitable', first)
    const res2 = await callPost('hospitable', second)

    expect(await res1.clone().json()).not.toHaveProperty('duplicate')
    expect(await res2.clone().json()).toMatchObject({ received: true, duplicate: true })
    expect(adapter.handleWebhookEvent).toHaveBeenCalledTimes(1)
    expect(supabase.insertedIds.size).toBe(1)
  })

  it('rejects an over-nested payload with a 400 instead of a 500', async () => {
    // JSON.parse accepts ~20,000 levels but JSON.stringify overflows the stack
    // at ~5,000, so the stringify call this replaced threw an uncaught
    // RangeError and the route answered 500 — reachable by anyone who could
    // POST a body here.
    // Built as a raw string: JSON.stringify would overflow constructing the
    // fixture, which is the very asymmetry under test — JSON.parse accepts
    // this depth and JSON.stringify does not.
    const depth = 5_000
    const body  = `{"action":"entity_update","data":${'{"nested":'.repeat(depth)}1${'}'.repeat(depth)}}`

    const res = await POST(
      new NextRequest('http://localhost/api/webhooks/hospitable', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      { params: Promise.resolve({ provider: 'hospitable' }) },
    )

    expect(res.status).toBe(400)
    expect(adapter.handleWebhookEvent).not.toHaveBeenCalled()
    expect(supabase.insertedIds.size).toBe(0)
  })

  it('discards an identical retried payload as a no-op without invoking the handler again', async () => {
    const payload = { action: 'reservation.changed', id: 'evt_stable_reused_id', reservation_id: 'res_1', created: '2026-07-21T00:00:00Z' }

    const first  = await callPost('hospitable', payload)
    const second = await callPost('hospitable', payload)

    expect(first.status).toBe(200)
    expect(await first.clone().json()).not.toHaveProperty('duplicate')

    expect(second.status).toBe(200)
    expect(await second.clone().json()).toMatchObject({ received: true, duplicate: true })

    expect(adapter.handleWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('does not conflate two distinct payloads carrying the same reused payload.id', async () => {
    // Per the route's own comment: Hospitable's docs claim reservation.changed
    // reuses the reservation's stable id in the `id` field across genuinely
    // different events. A content hash must still tell these apart.
    const first  = { action: 'reservation.changed', id: 'evt_stable_reused_id', reservation_id: 'res_1', created: '2026-07-21T00:00:00Z', data: { status: 'modified' } }
    const second = { action: 'reservation.changed', id: 'evt_stable_reused_id', reservation_id: 'res_1', created: '2026-07-21T01:00:00Z', data: { status: 'cancelled' } }

    const res1 = await callPost('hospitable', first)
    const res2 = await callPost('hospitable', second)

    expect(await res1.clone().json()).not.toHaveProperty('duplicate')
    expect(await res2.clone().json()).not.toHaveProperty('duplicate')
    expect(adapter.handleWebhookEvent).toHaveBeenCalledTimes(2)
    expect(supabase.insertedIds.size).toBe(2)
  })

  it('scopes the dedup key per provider — identical payloads from different providers do not collide', async () => {
    const payload = { action: 'entity_update', id: 'evt_1', entity_type: 'booking' }

    const res1 = await callPost('ownerrez', payload)
    ;(getProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeProviderAdapter())
    const res2 = await callPost('hospitable', payload)

    expect(await res1.clone().json()).not.toHaveProperty('duplicate')
    expect(await res2.clone().json()).not.toHaveProperty('duplicate')
    expect(supabase.insertedIds.size).toBe(2)
  })

  // Was: "skips the dedup path entirely for the universal
  // authorization_revoked action". That skip was the defect. Revocation
  // returned 200 ahead of the claim insert, so it was the one event class with
  // no dedup at all — its only protection was processRevocation's
  // read-status-then-act sequence, a TOCTOU that let two concurrent
  // redeliveries both observe status='active', both revoke, and both write an
  // integration.revoked audit row. (The PM notification is already collapsed
  // by notifyIntegrationError's day-scoped dedupeKey, and the revoke RPC is
  // idempotent, so the duplicate audit row is the whole residual harm.) It now
  // takes a claim like every other event, so the unique index collapses them.
  it('claims a dedup row for the universal authorization_revoked action', async () => {
    const payload = { action: 'application_authorization_revoked', user_id: '12345' }

    await callPost('ownerrez', payload)

    expect(supabase.insertedIds.size).toBe(1)
    // Still short-circuits the provider adapter — revocation is handled
    // universally, not delegated.
    expect(adapter.handleWebhookEvent).not.toHaveBeenCalled()
  })

  it('discards a redelivered revocation instead of revoking twice', async () => {
    const payload = { action: 'application_authorization_revoked', user_id: '12345' }

    const res1 = await callPost('ownerrez', payload)
    const res2 = await callPost('ownerrez', payload)

    expect(await res1.clone().json()).not.toHaveProperty('duplicate')
    expect(await res2.clone().json()).toEqual({ received: true, duplicate: true })
    expect(supabase.insertedIds.size).toBe(1)
  })
})
