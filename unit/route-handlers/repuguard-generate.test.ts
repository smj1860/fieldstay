import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ getAll: () => [] })),
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  repuguardLimiter: { limit: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })) },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/repuguard/generate-response', () => ({
  generateReviewResponse: vi.fn(),
}))

import { POST } from '@/app/api/repuguard/generate/route'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/server'
import { repuguardLimiter } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit'
import { generateReviewResponse } from '@/lib/repuguard/generate-response'

const USER_ID = 'user_1'
const ORG_ID  = 'org_1'

type Resp = { data?: unknown; error?: unknown }

function makeAdmin(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'not', 'upsert', 'update']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

function makeAuthClient(user: { id: string } | null) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user } })) } }
}

function baseReview(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'review_1', org_id: ORG_ID, external_source: 'airbnb',
    review_text: 'The place was great but the wifi was slow.',
    rating: 4, guest_name: 'Jamie', internal_notes: null,
    properties: { name: 'Lakeview Cabin' },
    ...overrides,
  }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/repuguard/generate', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/repuguard/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(repuguardLimiter.limit).mockResolvedValue({ success: true, reset: Date.now() + 1000 } as never)
  })

  it('rejects an unauthenticated request before rate limiting or touching the DB', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient(null) as never)

    const res = await POST(postRequest({ review_id: 'review_1' }))

    expect(res.status).toBe(401)
    expect(repuguardLimiter.limit).not.toHaveBeenCalled()
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 429 with a Retry-After header when the daily generation limit is exceeded', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    vi.mocked(repuguardLimiter.limit).mockResolvedValue({ success: false, reset: Date.now() + 5000 } as never)

    const res = await POST(postRequest({ review_id: 'review_1' }))

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a request missing review_id', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)

    const res = await POST(postRequest({}))

    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a caller with no accepted org membership', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({ organization_members: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await POST(postRequest({ review_id: 'review_1' }))

    expect(res.status).toBe(403)
  })

  it('rejects when RepuGuard is not active for the org', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: { org_id: ORG_ID }, error: null }],
      organizations:        [{ data: { repuguard_status: 'inactive' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await POST(postRequest({ review_id: 'review_1' }))

    expect(res.status).toBe(403)
  })

  it('IDOR: returns 404 for a review_id belonging to a different org — the lookup is scoped by org_id', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: { org_id: ORG_ID }, error: null }],
      organizations:        [{ data: { repuguard_status: 'active' }, error: null }],
      reviews:              [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await POST(postRequest({ review_id: 'other_org_review' }))

    expect(res.status).toBe(404)
    const reviewEq = admin.calls.filter((c) => c.table === 'reviews' && c.method === 'eq')
    expect(reviewEq.some((c) => c.args[0] === 'id' && c.args[1] === 'other_org_review')).toBe(true)
    expect(reviewEq.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    expect(generateReviewResponse).not.toHaveBeenCalled()
  })

  it('rejects regenerating a manually-pasted review that already has a response', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: { org_id: ORG_ID }, error: null }],
      organizations:        [{ data: { repuguard_status: 'active' }, error: null }],
      reviews:              [{ data: baseReview({ external_source: 'manual' }), error: null }],
      review_responses:     [{ data: { id: 'resp_1', regeneration_count: 0, generated_response: 'Thanks!' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await POST(postRequest({ review_id: 'review_1' }))

    expect(res.status).toBe(403)
    expect(generateReviewResponse).not.toHaveBeenCalled()
  })

  it('rejects regenerating a synced review past the max regeneration count', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: { org_id: ORG_ID }, error: null }],
      organizations:        [{ data: { repuguard_status: 'active' }, error: null }],
      reviews:              [{ data: baseReview(), error: null }],
      review_responses:     [{ data: { id: 'resp_1', regeneration_count: 2, generated_response: 'Thanks!' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const res = await POST(postRequest({ review_id: 'review_1' }))

    expect(res.status).toBe(429)
    expect(generateReviewResponse).not.toHaveBeenCalled()
  })

  it('returns a generic 500 when generation fails, logging the real error server-side', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: { org_id: ORG_ID }, error: null }],
      organizations:        [{ data: { repuguard_status: 'active' }, error: null }],
      reviews:              [{ data: baseReview(), error: null }],
      review_responses:     [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(generateReviewResponse).mockRejectedValue(new Error('model retired'))

    const res = await POST(postRequest({ review_id: 'review_1' }))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.error).not.toContain('model retired')
    expect(consoleErr).toHaveBeenCalled()
    consoleErr.mockRestore()
  })

  it('generates and saves a first-draft response, scoping the upsert and audit log to the caller\'s own org_id (server-derived, not client-supplied)', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: { org_id: ORG_ID }, error: null }],
      organizations:        [{ data: { repuguard_status: 'active' }, error: null }],
      reviews:              [{ data: baseReview(), error: null }],
      review_responses:     [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(generateReviewResponse).mockResolvedValue({
      response: 'Thanks for staying with us!', word_count: 150, tone_used: 'warm',
      flags: [], flag_reason: null,
    })

    const res = await POST(postRequest({ review_id: 'review_1', org_id: 'attacker_org' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)

    const upsertCall = admin.calls.find((c) => c.table === 'review_responses' && c.method === 'upsert')
    expect(upsertCall).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const upserted = upsertCall!.args[0] as any
    expect(upserted.org_id).toBe(ORG_ID)
    expect(upserted.review_id).toBe('review_1')
    expect(upserted.regeneration_count).toBe(0)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, actorId: USER_ID, action: 'repuguard.response.generated', targetId: 'review_1',
    }))
  })

  it('flags a response with legal/safety concerns as draft instead of ready', async () => {
    vi.mocked(createServerClient).mockReturnValue(makeAuthClient({ id: USER_ID }) as never)
    const admin = makeAdmin({
      organization_members: [{ data: { org_id: ORG_ID }, error: null }],
      organizations:        [{ data: { repuguard_status: 'active' }, error: null }],
      reviews:              [{ data: baseReview(), error: null }],
      review_responses:     [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)
    vi.mocked(generateReviewResponse).mockResolvedValue({
      response: 'held pending review', word_count: 10, tone_used: 'neutral',
      flags: ['legal'], flag_reason: 'guest threatened legal action',
    })

    await POST(postRequest({ review_id: 'review_1' }))

    const reviewUpdate = admin.calls.find((c) => c.table === 'reviews' && c.method === 'update')
    expect(reviewUpdate).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((reviewUpdate!.args[0] as any).response_status).toBe('draft')
  })
})
