import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as signEd25519 } from 'crypto'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))
vi.mock('@/lib/sms/telnyx', () => ({
  normalizePhoneToE164: vi.fn((v: string) => (v.startsWith('+') ? v : null)),
}))

import { POST } from '@/app/api/webhooks/telnyx/route'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'

// ============================================================================
// L-3: Ed25519 verification proves AUTHENTICITY, not freshness. Before this,
// the only bound on replaying a captured Telnyx delivery was the 300-second
// timestamp-freshness window, and that was harmless only because every branch
// happened to be idempotent — a property of the branches, not of the route.
// A dedup claim over the SIGNED payload (`timestamp|rawBody`) removes the
// dependency on that reasoning, and must be RELEASED if the handler throws so
// a real STOP is never silently discarded as a duplicate.
// ============================================================================

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(opts: {
  dedupResult?:  Resp
  optinResult?:  Resp
} = {}) {
  const calls: { table: string; method: string }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    let result: Resp =
      table === 'processed_webhooks'
        ? (opts.dedupResult ?? { error: null })
        : (opts.optinResult ?? { data: [], error: null })

    for (const m of ['select', 'update', 'eq']) {
      chain[m] = vi.fn(() => { calls.push({ table, method: m }); return chain })
    }
    chain.insert = vi.fn(() => {
      calls.push({ table, method: 'insert' })
      return chain
    })
    chain.delete = vi.fn(() => {
      calls.push({ table, method: 'delete' })
      result = { error: null }
      return chain
    })
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })

  return { from, calls }
}

describe('POST /api/webhooks/telnyx — replay protection', () => {
  const ORIGINAL_ENV = { ...process.env }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' })
  const publicKeyB64 = publicKeyDer.subarray(publicKeyDer.length - 32).toString('base64')

  const body = JSON.stringify({
    data: { event_type: 'message.received', payload: { from: { phone_number: '+15551234567' }, text: 'STOP' } },
  })

  function signedRequest() {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = signEd25519(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64')
    return new NextRequest('http://localhost/api/webhooks/telnyx', {
      method:  'POST',
      headers: {
        'telnyx-signature-ed25519': signature,
        'telnyx-timestamp':         timestamp,
      },
      body,
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY = publicKeyB64
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('claims the delivery and processes a first-time STOP', async () => {
    const supabase = makeSupabase({ optinResult: { data: [{ org_id: 'org_1' }], error: null } })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await POST(signedRequest())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    expect(supabase.calls.some((c) => c.table === 'processed_webhooks' && c.method === 'insert')).toBe(true)
    expect(logAuditEvents).toHaveBeenCalled()
  })

  it('discards a replay of the exact same signed payload without touching the opt-in table', async () => {
    const supabase = makeSupabase({ dedupResult: { error: { code: '23505' } } })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await POST(signedRequest())

    expect(await res.json()).toEqual({ received: true, duplicate: true })
    expect(supabase.from).not.toHaveBeenCalledWith('guidebook_guest_sms_optins')
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('releases the dedup claim and 500s when the consent write fails, so Telnyx retries rather than losing a STOP', async () => {
    const supabase = makeSupabase({ optinResult: { data: null, error: { message: 'deadlock detected' } } })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await POST(signedRequest())

    expect(res.status).toBe(500)
    expect(supabase.calls.some((c) => c.table === 'processed_webhooks' && c.method === 'delete')).toBe(true)
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('still processes the message when the dedup table itself is unavailable (fails open — a dropped STOP is a compliance failure)', async () => {
    const supabase = makeSupabase({
      dedupResult: { error: { code: '42P01', message: 'relation does not exist' } },
      optinResult: { data: [{ org_id: 'org_1' }], error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await POST(signedRequest())

    expect(res.status).toBe(200)
    expect(logAuditEvents).toHaveBeenCalled()
  })
})
