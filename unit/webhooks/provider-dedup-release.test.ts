import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createHash } from 'crypto'

// BLOCKER-3: the dedup claim in `processed_webhooks` is written BEFORE
// handleWebhookEvent runs (so concurrent redeliveries collapse to one), but
// that means a handler failure (Inngest unreachable, malformed event) leaves
// the claim in place forever — the provider's retry, which resends a
// byte-identical body and so hashes identically, gets silently discarded as
// a duplicate. These tests prove the route deletes its own claim on handler
// failure so the next identical retry gets through instead of being dropped.
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
import { reportError } from '@/lib/observability/report-error'

// Same stateful fake as provider-webhook-dedup.test.ts, extended with a
// working .delete().eq('webhook_id', ...) chain that actually removes the
// row from insertedIds — needed to prove the release path really frees the
// key up for a subsequent retry rather than just not-erroring.
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
    chain.delete = vi.fn(() => {
      let deleteWebhookId: string | undefined
      const deleteChain = {
        eq: vi.fn((column: string, value: string) => {
          if (table === 'processed_webhooks' && column === 'webhook_id') {
            deleteWebhookId = value
            insertedIds.delete(deleteWebhookId)
          }
          return Promise.resolve({ error: null })
        }),
      }
      return deleteChain
    })
    chain.select      = vi.fn(() => chain)
    chain.eq          = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null }))
    return chain
  })
  return { from, rpc, insertedIds }
}

function makeProviderAdapter() {
  return {
    authType:           'apiKey' as const,
    validateWebhook:    vi.fn(() => Promise.resolve({ valid: true })),
    handleWebhookEvent: vi.fn(() => Promise.resolve()),
    getApiHeaders:      vi.fn(() => ({})),
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

describe('POST /api/webhooks/[provider] — dedup claim release on handler failure', () => {
  let supabase: ReturnType<typeof makeSupabase>
  let adapter: ReturnType<typeof makeProviderAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = makeSupabase()
    adapter  = makeProviderAdapter()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getProvider as ReturnType<typeof vi.fn>).mockReturnValue(adapter)
  })

  it('deletes the processed_webhooks claim when handleWebhookEvent throws, and still returns 200', async () => {
    const payload = { action: 'reservation.changed', id: 'evt_1', data: { id: 'res_1' } }
    const expectedKey = `hospitable:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`
    adapter.handleWebhookEvent.mockRejectedValueOnce(new Error('Inngest unreachable'))

    const res = await callPost('hospitable', payload)

    expect(res.status).toBe(200)
    expect(await res.clone().json()).toEqual({ received: true })
    expect(supabase.insertedIds.has(expectedKey)).toBe(false)
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'webhook.provider.handler' }),
    )
  })

  it('lets an identical retry through after the claim was released by a prior handler failure', async () => {
    const payload = { action: 'reservation.changed', id: 'evt_1', data: { id: 'res_1' } }
    adapter.handleWebhookEvent.mockRejectedValueOnce(new Error('Inngest unreachable'))

    const first = await callPost('hospitable', payload)
    expect(await first.clone().json()).not.toHaveProperty('duplicate')
    expect(adapter.handleWebhookEvent).toHaveBeenCalledTimes(1)

    adapter.handleWebhookEvent.mockResolvedValueOnce(undefined)
    const second = await callPost('hospitable', payload)

    expect(await second.clone().json()).not.toHaveProperty('duplicate')
    expect(adapter.handleWebhookEvent).toHaveBeenCalledTimes(2)
  })

  it('keeps the claim in place (no release) when the handler succeeds, so a genuine retry is still deduped', async () => {
    const payload = { action: 'reservation.changed', id: 'evt_1', data: { id: 'res_1' } }
    const expectedKey = `hospitable:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`

    await callPost('hospitable', payload)
    expect(supabase.insertedIds.has(expectedKey)).toBe(true)

    const second = await callPost('hospitable', payload)
    expect(await second.clone().json()).toMatchObject({ received: true, duplicate: true })
    expect(adapter.handleWebhookEvent).toHaveBeenCalledTimes(1)
  })
})
