import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  workOrderRatelimit: { limit: vi.fn(async () => ({ success: true })) },
}))
vi.mock('@/lib/integrations/webhook-verification', () => ({
  extractClientIp: vi.fn(() => '203.0.113.5'),
}))

import { POST, DELETE } from '@/app/api/work-orders/[token]/photos/route'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit } from '@/lib/rate-limit'

type Resp = { data?: unknown; error?: unknown; count?: number }

function makeSupabase(queue: Record<string, Resp[]>) {
  const uploadMock = vi.fn(async () => ({ error: null }))
  const removeMock = vi.fn(async () => ({ error: null }))
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  const storage = { from: vi.fn(() => ({ upload: uploadMock, remove: removeMock })) }
  return { from, storage, calls, uploadMock, removeMock }
}

function baseWo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id:                          'wo_1',
    status:                      'assigned',
    portal_enabled:              true,
    completion_token_expires_at: null,
    ...overrides,
  }
}

const VALID_TOKEN = 'wo-completion-token-1234567890'

function postRequest(token: string, formData: FormData) {
  return new NextRequest(`http://localhost/api/work-orders/${token}/photos`, {
    method: 'POST',
    body:   formData,
  })
}

function deleteRequest(token: string, body: unknown) {
  return new NextRequest(`http://localhost/api/work-orders/${token}/photos`, {
    method:  'DELETE',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

// route.ts's own return-type inference (loadOpenWorkOrder's two-branch return
// shape) widens to `NextResponse | undefined` even though every code path
// actually returns a real NextResponse — the `!` reflects that real runtime
// guarantee, not a genuine possibility of undefined.
async function callPost(token: string, formData: FormData): Promise<NextResponse> {
  return (await POST(postRequest(token, formData), { params: Promise.resolve({ token }) }))!
}

async function callDelete(token: string, body: unknown): Promise<NextResponse> {
  return (await DELETE(deleteRequest(token, body), { params: Promise.resolve({ token }) }))!
}

function photoFile(name = 'photo.jpg', type = 'image/jpeg', bytes = 100) {
  return new File([new Uint8Array(bytes)], name, { type })
}

describe('POST /api/work-orders/[token]/photos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: true } as never)
  })

  it('returns 429 and never touches the DB when the IP rate limit is exceeded', async () => {
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: false } as never)
    const formData = new FormData()
    formData.append('photos', photoFile())

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(429)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 404 for an invalid/nonexistent token before any upload', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    formData.append('photos', photoFile())

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(404)
    expect(supabase.uploadMock).not.toHaveBeenCalled()
  })

  it('rejects when the vendor portal is not enabled', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: baseWo({ portal_enabled: false }), error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    formData.append('photos', photoFile())

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(403)
  })

  it('rejects uploads on an already-closed work order', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: baseWo({ status: 'completed' }), error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    formData.append('photos', photoFile())

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(409)
  })

  it('rejects uploads on an expired token', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo({ completion_token_expires_at: '2020-01-01T00:00:00.000Z' }), error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    formData.append('photos', photoFile())

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(410)
  })

  it('rejects a request with no photo files', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: baseWo(), error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callPost(VALID_TOKEN, new FormData())

    expect(res.status).toBe(400)
  })

  it('rejects more than the per-request max photo count', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      work_order_photos: [{ data: null, error: null, count: 0 }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    for (let i = 0; i < 6; i++) formData.append('photos', photoFile(`p${i}.jpg`))

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(400)
  })

  it('rejects when the running total across requests would exceed the max', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      work_order_photos: [{ data: null, error: null, count: 4 }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    formData.append('photos', photoFile('p0.jpg'))
    formData.append('photos', photoFile('p1.jpg'))

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(400)
  })

  it('rejects an oversized photo', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      work_order_photos: [{ data: null, error: null, count: 0 }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    formData.append('photos', photoFile('big.jpg', 'image/jpeg', 11 * 1024 * 1024))

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(400)
  })

  it('rejects a disallowed MIME type', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      work_order_photos: [{ data: null, error: null, count: 0 }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    formData.append('photos', photoFile('doc.pdf', 'application/pdf'))

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(400)
  })

  it('uploads a valid photo and inserts a work_order_photos row scoped to this work order', async () => {
    const supabase = makeSupabase({
      work_orders:        [{ data: baseWo(), error: null }],
      work_order_photos:  [
        { data: null, error: null, count: 0 },
        { data: { id: 'photo_1', storage_path: 'work-orders/wo_1/completion/x.jpg' }, error: null },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    formData.append('photos', photoFile())

    const res = await callPost(VALID_TOKEN, formData)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.uploaded).toHaveLength(1)
    expect(supabase.uploadMock).toHaveBeenCalledTimes(1)
    const insertCall = supabase.calls.find((c) => c.table === 'work_order_photos' && c.method === 'insert')
    expect((insertCall!.args[0] as Record<string, unknown>).work_order_id).toBe('wo_1')
  })

  it('cleans up the storage object when the DB insert fails', async () => {
    const supabase = makeSupabase({
      work_orders:        [{ data: baseWo(), error: null }],
      work_order_photos:  [
        { data: null, error: null, count: 0 },
        { data: null, error: { message: 'insert failed' } },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    const formData = new FormData()
    formData.append('photos', photoFile())

    const res = await callPost(VALID_TOKEN, formData)

    expect(res.status).toBe(500)
    expect(supabase.removeMock).toHaveBeenCalled()
  })
})

describe('DELETE /api/work-orders/[token]/photos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: true } as never)
  })

  it('returns 429 and never touches the DB when the IP rate limit is exceeded', async () => {
    vi.mocked(workOrderRatelimit.limit).mockResolvedValue({ success: false } as never)

    const res = await callDelete(VALID_TOKEN, { photoId: 'photo_1' })

    expect(res.status).toBe(429)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 404 for an invalid token before any deletion', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callDelete(VALID_TOKEN, { photoId: 'photo_1' })

    expect(res.status).toBe(404)
    expect(supabase.removeMock).not.toHaveBeenCalled()
  })

  it('requires a photoId', async () => {
    const supabase = makeSupabase({ work_orders: [{ data: baseWo(), error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callDelete(VALID_TOKEN, {})

    expect(res.status).toBe(400)
  })

  it('IDOR: rejects deleting a photo that belongs to a different work order than the one the token authorizes', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      work_order_photos: [{
        data: { id: 'photo_1', storage_path: 'work-orders/OTHER_WO/completion/x.jpg', work_order_id: 'OTHER_WO' },
        error: null,
      }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callDelete(VALID_TOKEN, { photoId: 'photo_1' })

    expect(res.status).toBe(404)
    expect(supabase.removeMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the photoId does not exist at all', async () => {
    const supabase = makeSupabase({
      work_orders:        [{ data: baseWo(), error: null }],
      work_order_photos:  [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callDelete(VALID_TOKEN, { photoId: 'nonexistent' })

    expect(res.status).toBe(404)
  })

  it('deletes a photo that belongs to the work order the token authorizes', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: baseWo(), error: null }],
      work_order_photos: [
        { data: { id: 'photo_1', storage_path: 'work-orders/wo_1/completion/x.jpg', work_order_id: 'wo_1' }, error: null },
        { data: null, error: null },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await callDelete(VALID_TOKEN, { photoId: 'photo_1' })
    const json = await res.json()

    expect(json).toEqual({ success: true })
    expect(supabase.removeMock).toHaveBeenCalledWith(['work-orders/wo_1/completion/x.jpg'])
  })
})
